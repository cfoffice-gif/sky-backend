require("dotenv").config();
const { Bot } = require("grammy");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
async function sendToPythonAgent(body) {
  try {
    const res = await axios.post("http://127.0.0.1:3002/desktop", body);
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
}
// --- ENV ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}
if (!SERPAPI_API_KEY) {
  console.error("Missing SERPAPI_API_KEY in .env");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing Supabase config in .env");
  process.exit(1);
}

// --- Supabase client ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: {
    enabled: false
  }
});

// --- Telegram bot ---
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// --- OpenAI helper ---
async function askOpenAI(systemPrompt, userMessage) {
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.4,
  };

  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  return res.data.choices[0].message.content;
}

// --- SerpAPI helper (business search) ---
async function searchBusinessOnSerpAPI(query, location = "Florida, USA") {
  const url = "https://serpapi.com/search";
  const params = {
    api_key: SERPAPI_API_KEY,
    engine: "google_maps",
    q: query,
    ll: "@29.1872,-82.1401,12z", // Ocala-ish area
    type: "search",
  };

  const res = await axios.get(url, { params });
  const data = res.data;

  if (!data.local_results || data.local_results.length === 0) {
    return [];
  }

  return data.local_results.map((b) => ({
    name: b.title || "",
    address: b.address || "",
    phone: b.phone || "",
    website: b.website || "",
    rating: b.rating || null,
    reviews: b.user_ratings_total || null,
    category: b.category || "",
    link: b.link || "",
  }));
}

// --- Supabase: office workflows ---
async function saveOfficeWorkflow(name, description, steps) {
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      name,
      description,
      steps,
      created_by: "office",
    })
    .select()
    .single();

  if (error) {
    console.error("Error saving workflow:", error);
    throw error;
  }
  return data;
}

async function listOfficeWorkflows() {
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error listing workflows:", error);
    throw error;
  }
  return data || [];
}

async function getOfficeWorkflowByName(name) {
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error getting workflow:", error);
    throw error;
  }
  return data;
}

// --- Supabase: office rules ---
async function saveOfficeRule(category, ruleText, priority = 1) {
  const { data, error } = await supabase
    .from("rules")
    .insert({
      category,
      rule_text: ruleText,
      priority,
      created_by: "office",
    })
    .select()
    .single();

  if (error) {
    console.error("Error saving rule:", error);
    throw error;
  }
  return data;
}

async function listOfficeRules(category = null) {
  let query = supabase.from("rules").select("*").order("created_at", {
    ascending: false,
  });

  if (category) {
    query = query.ilike("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Error listing rules:", error);
    throw error;
  }
  return data || [];
}

// --- Supabase: office preferences ---
async function saveOfficePreference(key, value) {
  const { data, error } = await supabase
    .from("preferences")
    .insert({
      user_id: "office",
      key,
      value,
    })
    .select()
    .single();

  if (error) {
    console.error("Error saving preference:", error);
    throw error;
  }
  return data;
}

async function listOfficePreferences() {
  const { data, error } = await supabase
    .from("preferences")
    .select("*")
    .eq("user_id", "office")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error listing preferences:", error);
    throw error;
  }
  return data || [];
}

// --- System prompt for Sky ---
const SYSTEM_PROMPT = `
You are Sky, an AI office coworker for Chelsi's propane/inspection/permit business.

You run inside a Telegram bot using grammY, with:
- OpenAI as your brain
- SerpAPI for business lookups
- Supabase for global memory

You support:
- Normal chat (like ChatGPT)
- Business search via SerpAPI
- Office workflows (save, list, retrieve)
- Office rules (save, list)
- Office preferences (save, list)

You speak clearly, concisely, and in a practical, business-focused tone.
When the user asks for something structured (workflow, rules, preferences, search),
you respond with clear bullet points and labels.
`;

// --- Command parsing helpers ---
function normalize(text) {
  return text.trim().toLowerCase();
}

// Parse "remember office workflow: NAME - steps: 1..., 2..." style
function parseWorkflowFromText(text) {
  // Extract workflow name
  const nameMatch = text.match(/workflow[:\-]\s*(.+)/i);
  const name = nameMatch ? nameMatch[1].split("\n")[0].trim() : "Unnamed workflow";

  // Extract numbered steps
  const steps = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+[\.\)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[\.\)]\s+/, ""));

  return { name, steps };
}
// --- Telegram message handler ---
bot.on("message", async (ctx) => {
  console.log("Received message:", ctx.message.text);

  const text = ctx.message.text || "";
  const lower = text.toLowerCase();

  // --- Desktop test command ---
  if (lower === "sky test desktop") {
    await sendToPythonAgent({ action: "move", x: 500, y: 500 });
    await sendToPythonAgent({ action: "click" });
    return ctx.reply("Sky clicked your desktop!");
  }

  // --- Desktop: Scroll ---
  if (lower === "sky scroll") {
    await sendToPythonAgent({ action: "scroll", y: -500 });
    return ctx.reply("Scrolling!");
  }

  // --- Desktop: Right Click ---
  if (lower === "sky right click") {
    await sendToPythonAgent({ action: "rightClick" });
    return ctx.reply("Right click done!");
  }

  // --- Desktop: Double Click ---
  if (lower === "sky double click") {
    await sendToPythonAgent({ action: "doubleClick" });
    return ctx.reply("Double click done!");
  }

  // --- Desktop: Drag ---
  if (lower.startsWith("sky drag")) {
    const parts = lower.split(" ");
    const x = parseInt(parts[2]);
    const y = parseInt(parts[3]);

    await sendToPythonAgent({ action: "drag", x, y });
    return ctx.reply(`Dragging to ${x}, ${y}`);
  }

  // --- Desktop: Type ---
  if (lower.startsWith("sky type")) {
    const textToType = text.substring(8);
    await sendToPythonAgent({ action: "type", text: textToType });
    return ctx.reply(`Typed: ${textToType}`);
  }

  // --- Office workflow saving ---
  if (lower.startsWith("remember office workflow")) {
    const { name, steps } = parseWorkflowFromText(text);
    const saved = await saveOfficeWorkflow(name, "", steps);
    return ctx.reply(`Saved office workflow: ${saved.name}`);
  }

  // --- List workflows ---
  if (lower.includes("show office workflows") || lower.includes("list office workflows")) {
    const workflows = await listOfficeWorkflows();
    if (workflows.length === 0) return ctx.reply("No office workflows saved yet.");
    return ctx.reply(
      workflows
        .map((w) => `• ${w.name} (${w.steps.length} steps)`)
        .join("\n")
    );
  }

  // --- Normal chat (OpenAI fallback) ---
  const reply = await askOpenAI(SYSTEM_PROMPT, text);
  return ctx.reply(reply);
});


// --- START THE BOT ---
bot.start();
console.log("Sky is running and connected to Telegram...");

