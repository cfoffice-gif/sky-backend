require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { Bot } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { plan } = require("./modules/planner");
const { createMemoryModule } = require("./modules/memory");
const app = express();
app.use(express.json());

// --- ENV ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL || "http://127.0.0.1:3002/desktop";

const USERS = {
  "8675862264": {
    name: "Chelsi",
    role: "ocala branch manager",
    email: "chelsi@centennialpools.com"
  },
  "SARA_TELEGRAM_ID": {
    name: "Sara",
    role: "owner",
    email: "sara@centennialpools.com"
  },
  "KEN_TELEGRAM_ID": {
    name: "Ken",
    role: "owner",
    email: "ken@centennialpools.com"
  }
};
if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing Supabase config in .env");
  process.exit(1);
}

// --- Health check route ---
app.get("/", (req, res) => {
  res.send("Sky backend is running");
});

// --- Supabase ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { enabled: false },
});

const memory = createMemoryModule(supabase);

async function saveMemory(userName, category, memory) {
  await supabase.from("memories").insert([
    {
      user_name: userName,
      category,
      memory
    }
  ]);
}

async function getMemories(userName) {
  const { data } = await supabase
    .from("memories")
    .select("*")
    .eq("user_name", userName)
    .order("created_at", { ascending: false })
    .limit(20);
  
  return data || [];
}
async function saveReminder(userName, telegramId, reminder, dueAt, originalText) {
  const { data, error } = await supabase
    .from("reminders")
    .insert([
      {
        user_name: userName,
        telegram_id: String(telegramId || ""),
        reminder,
        due_at: dueAt,
        original_text: originalText,
        completed: false,
        sent: false
      }
    ])
    .select();

  console.log("Reminder insert data:", data);

  if (error) {
    console.error("Reminder insert error:", error);
  }

  return { data, error };
}
async function createDesktopJob(currentUser, action, payload, description) {
  const { data, error } = await supabase
    .from("desktop_jobs")
    .insert([
      {
        user_name: currentUser.name,
        telegram_id: String(currentUser.telegramId || ""),
        action,
        payload,
        description,
        status: "pending"
      }
    ])
    .select()
    .single();

  if (error) {
    console.error("Desktop job insert error:", error);
    return { success: false, error: error.message };
  }

  return { success: true, job: data };
}
async function saveFileMemory(userName, fileType, fileName, filePath, description) {
  const { data, error } = await supabase
    .from("files")
    .insert([
      {
        user_name: userName,
        file_type: fileType,
        file_name: fileName,
        file_path: filePath,
        description
      }
    ]);

  if (error) {
    console.error("File memory insert error:", error);
  }

  return data;
}
async function createSpreadsheetFile(currentUser, task) {
  const reply = await askOpenAI(
    SYSTEM_PROMPT,
    `
Create spreadsheet data for this request.

User:
${JSON.stringify(currentUser, null, 2)}

Request:
${task}

Return JSON only in this exact format:
{
  "fileName": "short-file-name.xlsx",
  "description": "what this spreadsheet is for",
  "sheets": [
    {
      "name": "Sheet1",
      "rows": [
        ["Column 1", "Column 2", "Column 3"],
        ["Example", "Example", "Example"]
      ]
    }
  ]
}
`
  );

  let parsed;

  try {
    parsed = JSON.parse(reply);
  } catch (err) {
    console.error("Spreadsheet JSON parse error:", reply);
    return {
      success: false,
      error: "I could not format the spreadsheet data correctly."
    };
  }

  const folder = path.join(__dirname, "generated_files");

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
  }

  const safeFileName = parsed.fileName.replace(/[^a-z0-9_.-]/gi, "_");
  const filePath = path.join(folder, safeFileName);

  const workbook = XLSX.utils.book_new();

  for (const sheet of parsed.sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.substring(0, 31));
  }

  XLSX.writeFile(workbook, filePath);

  await saveFileMemory(
    currentUser.name,
    "spreadsheet",
    safeFileName,
    filePath,
    parsed.description
  );

  return {
    success: true,
    fileName: safeFileName,
    filePath,
    description: parsed.description
  };
}

async function createPDFFile(currentUser, task) {
  const reply = await askOpenAI(
    SYSTEM_PROMPT,
    `
Create PDF content for this request.

User:
${JSON.stringify(currentUser, null, 2)}

Request:
${task}

Return JSON only in this exact format:
{
  "fileName": "short-file-name.pdf",
  "title": "Document Title",
  "description": "what this PDF is for",
  "sections": [
    {
      "heading": "Section Heading",
      "body": "Section body text"
    }
  ]
}
`
  );

  let parsed;

  try {
    parsed = JSON.parse(reply);
  } catch (err) {
    console.error("PDF JSON parse error:", reply);
    return {
      success: false,
      error: "I could not format the PDF content correctly."
    };
  }

  const folder = path.join(__dirname, "generated_files");

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
  }

  const safeFileName = parsed.fileName.replace(/[^a-z0-9_.-]/gi, "_");
  const filePath = path.join(folder, safeFileName);

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);

  doc.pipe(stream);

  doc.fontSize(20).text(parsed.title, { align: "center" });
  doc.moveDown();

  for (const section of parsed.sections) {
    doc.fontSize(14).text(section.heading, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(section.body, {
      align: "left"
    });
    doc.moveDown();
  }

  doc.end();

  await new Promise((resolve) => stream.on("finish", resolve));

  await saveFileMemory(
    currentUser.name,
    "pdf",
    safeFileName,
    filePath,
    parsed.description
  );

  return {
    success: true,
    fileName: safeFileName,
    filePath,
    description: parsed.description
  };
}
async function getDueReminders() {
  const now = new Date().toISOString();

  const { data } = await supabase
    .from("reminders")
    .select("*")
    .lte("due_at", now)
    .eq("sent", false);

  return data || [];
}    

// --- Telegram bot ---
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// --- Automatic reminder checker ---
setInterval(async () => {
  try {
    const reminders = await getDueReminders();

    for (const reminder of reminders) {
      const telegramId = reminder.telegram_id;

      if (!telegramId) continue;

      await bot.api.sendMessage(
        telegramId,
        "🔔 Reminder: " + reminder.reminder
      );

      await supabase
        .from("reminders")
        .update({ sent: true })
        .eq("id", reminder.id);
    }
  } catch (err) {
    console.error("Reminder checker error:", err.message);
  }
}, 60000);
// =============================
// Desktop Job Completion Watcher
// =============================
setInterval(async () => {
  try {
    const { data: jobs, error } = await supabase
      .from("desktop_jobs")
      .select("*")
      .eq("status", "completed")
      .eq("notified", false);

    if (error || !jobs || jobs.length === 0) return;

    for (const job of jobs) {
      try {
        await bot.api.sendMessage(
          Number(job.telegram_id),
          `✅ ${job.description} completed.`
      );

        await supabase
          .from("desktop_jobs")
          .update({ notified: true })
          .eq("id", job.id);

      } catch (err) {
        console.error("Desktop notification error:", err);
      }
    }
  } catch (err) {
    console.error("Desktop watcher error:", err);
  }
}, 3000);
// --- Send command to Python desktop agent ---
async function sendToPythonAgent(body) {
  try {
    const res = await axios.post(PYTHON_AGENT_URL, body, { timeout: 15000 });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- OpenAI helper ---
async function askOpenAI(systemPrompt, userMessage) {

    const url = "https://api.openai.com/v1/chat/completions";

    const body = {
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
        ],
        temperature: 0.4
    };

    const res = await axios.post(url, body, {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        }
    });

    return res.data.choices[0].message.content;
}


// ----------------------------
// Planner Brain
// ----------------------------

async function planSkyAction(userMessage) {
  const url = "https://api.openai.com/v1/chat/completions";

  const systemPrompt = `
You are Sky's planner brain for Chelsi.

Decide what Sky should do based on the user's message.

Return ONLY valid JSON. No explanation. No markdown.

Available actions:
- openProgram
- describeScreen
- screenshot
- save
- normalChat

Rules:
- If user asks to open, pull up, launch, get into, or bring up software, use openProgram.
- If user asks what you see, read the screen, look at the screen, analyze the screen, or explain an error, use describeScreen.
- If user asks to take/save a screenshot, use screenshot.
- If user asks to save the current file/work, use save.
- If it is just a question or writing request, use normalChat.

Program names:
- email/outlook/mail = outlook
- internet/browser/chrome/google = chrome
- spreadsheet/excel = excel
- word/document = word
- structure/pool design/design software/Structure Studios = structure
- notepad = notepad
- calculator = calculator

Examples:
{"action":"openProgram","program":"outlook"}
{"action":"describeScreen"}
{"action":"screenshot"}
{"action":"save"}
{"action":"normalChat"}
`;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
  };

  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  try {
    return JSON.parse(res.data.choices[0].message.content);
  } catch (err) {
    return { action: "normalChat" };
  }
}

// --- SerpAPI business search ---
async function searchBusinessOnSerpAPI(query) {
  if (!SERPAPI_API_KEY) {
    return [];
  }

  const url = "https://serpapi.com/search";
  const params = {
    api_key: SERPAPI_API_KEY,
    engine: "google_maps",
    q: query,
    ll: "@29.1872,-82.1401,12z",
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

// --- Supabase memory helpers ---
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

  if (error) throw error;
  return data;
}

async function listOfficeWorkflows() {
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

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

  if (error) throw error;
  return data;
}

async function listOfficeRules(category = null) {
  let query = supabase
    .from("rules")
    .select("*")
    .order("created_at", { ascending: false });

  if (category) {
    query = query.ilike("category", category);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

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

  if (error) throw error;
  return data;
}

async function listOfficePreferences() {
  const { data, error } = await supabase
    .from("preferences")
    .select("*")
    .eq("user_id", "office")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

// --- Sky personality ---
const SYSTEM_PROMPT = `
You are Sky, an AI office assistant for Chelsi and Centennial Pools.

You help with:
- Pool customer communication
- Proposals and contracts
- Office workflows
- Follow-up messages
- Pool design planning
- Permit and inspection reminders
- Business searches
- Computer control through the desktop agent

Speak clearly, practically, and professionally.
Keep answers helpful, concise, and business-focused.
`;

// --- Helpers ---
function parseWorkflowFromText(text) {
  const nameMatch = text.match(/workflow[:\-]\s*(.+)/i);
  const name = nameMatch
    ? nameMatch[1].split("\n")[0].trim()
    : "Unnamed workflow";

  const steps = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+[\.\)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[\.\)]\s+/, ""));

  return { name, steps };
}
async function executeAgentTool(tool) {
  if (tool.action === "openProgram") {
    return await sendToPythonAgent({
      action: "openProgram",
      text: tool.program,
    });
  }

  if (tool.action === "describeScreen") {
    return await sendToPythonAgent({
      action: "describeScreen",
    });
  }

  if (tool.action === "screenshot") {
    return await sendToPythonAgent({
      action: "screenshot",
    });
  }

  if (tool.action === "save") {
    return await sendToPythonAgent({
      action: "hotkey",
      keys: ["ctrl", "s"],
    });
  }

  if (tool.action === "wait") {
    await new Promise((resolve) => setTimeout(resolve, tool.ms || 2000));
    return { success: true };
  }

  if (tool.action === "normalChat") {
    return { success: true, normalChat: true };
  }

  if (tool.action === "createSpreadsheet") {
    return { success: true, createSpreadsheet: true };
  }

  if (tool.action === "createPDF") {
    return { success: true, createPDF: true };
  }

  if (tool.action === "reminder") {
    return { success: true, reminder: true };
  }

  if (tool.action === "remember") {
    return { success: true, remember: true };
  }

  return {
    success: false,
    error: "Unknown tool action: " + tool.action,
  };
}

async function runAgentTask(task, currentUser) {
  const url = "https://api.openai.com/v1/chat/completions";

  const systemPrompt = `
You are Sky, an AI secretary for Centennial Pools.

You are controlling a Windows computer through tools.

Your job is to choose ONE next tool at a time.

Return ONLY valid JSON.
No explanations.
No markdown.
No extra text.

Available tools:

1. openProgram
Use this to open software on the computer.
Programs available:
- chrome
- edge
- outlook
- excel
- word
- notepad
- calculator
- structure
- structure studios

2. describeScreen
Use this when you need to see what is currently on the screen.

3. screenshot
Use this only when the user specifically asks to save a screenshot.

4. save
Use this to press Ctrl+S.

5. wait
Use this when a program is loading.

6. done
Use this when the task is complete.

7. normalChat

8. remember

Use this when the user says:

remember
don't forget
make note
save this

Examples:

User:
Remember that Johnson Pool needs final inspection Friday.

Response:
{"action":"remember"}

User:
Don't forget Sara handles permits.

Response:
{"action":"remember"}

Use this when the user is asking a question, wants advice, needs an explanation, or is having a conversation.

9. 9. reminder

Use this when the user asks to be reminded later.

Examples:

User:
Remind me tomorrow to complete my EIN.

Response:
{"action":"reminder"}

10. createSpreadsheet

11. createPDF

Use this when the user asks for:

- a PDF
- a proposal
- a document
- a flyer
- an agreement
- a checklist

Examples:

User:
Create a warranty checklist PDF.

Response:
{"action":"createPDF"}

User:
Make a Johnson proposal PDF.

Response:
{"action":"createPDF"}

User:
Create a flyer.

Response:
{"action":"createPDF"}

Use this when the user asks for:

- a spreadsheet
- an excel file
- a checklist
- a tracking sheet

Examples:

User:
Create a permit checklist spreadsheet.

Response:
{"action":"createSpreadsheet"}

User:
Make a job tracking spreadsheet.

Response:
{"action":"createSpreadsheet"}

User:
Create an employee hours spreadsheet.

Response:
{"action":"createSpreadsheet"}

Use this when the user asks to be reminded later.

Examples:

User:
Remind me in 2 minutes to call Johnson.

Response:
{"action":"reminder"}

User:
Remind me tomorrow morning to schedule Smith final inspection.

Response:
{"action":"reminder"}

User:
Remind me Friday at 9 AM to call Sara.

Response:
{"action":"reminder"}

Examples:

User: What user am I?
Response:
{"action":"normalChat"}

User: Explain pool startup chemistry.
Response:
{"action":"normalChat"}

User: What is hydraulic cement?
Response:
{"action":"normalChat"}

User: What should I focus on today?
Response:
{"action":"normalChat"}

Important rules:
- If the user asks to open software, NEVER search the web.
- If the user asks to open Structure Studios, use openProgram with program "structure".
- If the user asks what you see, use describeScreen.
- If you just opened a program and the user also asked what you see, use describeScreen next.
- Do not use Chrome unless the user asks for internet, Google, a website, or web search.
- Complete the user's task using the available tools.
- After opening Structure Studios, wait 10 seconds before using describeScreen.
- After opening any other program, wait 5 seconds before using describeScreen.
- Do NOT describe the screen after opening a program unless the user specifically asks what you see, tells you to look at the screen, or asks you to analyze the screen.
- If the user only asks to open a program, open the program and then use done.
- If the user says "remind me", "set a reminder", "reminder", or "tomorrow remind me", ALWAYS return {"action":"reminder"}. Never use normalChat for reminder requests.

Examples:

User: Open Structure Studios
Response:
{"action":"openProgram","program":"structure"}

User: Open Structure Studios and tell me what you see
Step 1 response:
{"action":"openProgram","program":"structure"}

Step 2 response:
{"action":"wait","ms":20000}

Step 3 response:
{"action":"describeScreen"}

Step 4 response:
{"action":"done","message":"I opened Structure Studios and described what is on the screen."}

User: Pull up my email
Response:
{"action":"openProgram","program":"outlook"}

User: Open Chrome
Step 1 response:
{"action":"openProgram","program":"chrome"}

Step 2 response:
{"action":"done","message":"Opened Chrome."}

User: Open Word
Step 1 response:
{"action":"openProgram","program":"word"}

Step 2 response:
{"action":"done","message":"Opened Word."}

User: What do you see on my screen?
Response:
{"action":"describeScreen"}

User: Save this
Response:
{"action":"save"}

User:
Remind me in 2 minutes to call Johnson.
Response:
{"action":"reminder"}

User: Take a screenshot
Response:
{"action":"screenshot"}
`;

  let screenContext = "";
  let actionHistory = [];

  for (let step = 1; step <= 6; step++) {
    const body = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
      role: "user",
    content:
      "Current user:\n" +
      JSON.stringify(currentUser, null, 2) +
      "\n\nOriginal user task:\n" +
      task +
      "\n\nPrevious actions:\n" +
      JSON.stringify(actionHistory, null, 2) +
      "\n\nCurrent screen/context:\n" +
      screenContext +
      "\n\nChoose the next tool now."
  }
      ],
      temperature: 0,
    };

    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    let tool;

    try {
      tool = JSON.parse(res.data.choices[0].message.content.trim());
    } catch (err) {
      return "I had trouble deciding what to do next.";
    }

    if (tool.action === "done") {
      return tool.message || "Done.";
    }

  console.log("Tool chosen:", tool);

if (
  tool.action === "openProgram" ||
  tool.action === "describeScreen" ||
  tool.action === "screenshot" ||
  tool.action === "move" ||
  tool.action === "click" ||
  tool.action === "doubleClick" ||
  tool.action === "rightClick" ||
  tool.action === "type" ||
  tool.action === "hotkey" ||
  tool.action === "press" ||
  tool.action === "scroll" ||
  tool.action === "drag"
) {
  const desktopDescription =
  tool.action === "openProgram"
    ? "Opening " + (tool.program || tool.text || "the program")
    : "Running desktop action: " + tool.action;

const jobResult = await createDesktopJob(
  currentUser,
  tool.action,
  tool,
  desktopDescription
);

  if (!jobResult.success) {
    return "I tried to send that to the office computer, but got this error: " + jobResult.error;
  }

  return "I sent that to the office computer. Job #" + jobResult.job.id + " is waiting for the desktop agent.";
}

const result = await executeAgentTool(tool);

console.log("Result:", result);
    
    if (tool.action === "remember") {

  await memory.saveMemory(
  currentUser.name,
  "note",
  task
);

  return "Okay, I will remember that.";
}
    if (result.reminder) {
  const reply = await askOpenAI(
    SYSTEM_PROMPT,
    `
Convert this reminder request into JSON only.

Current date/time:
${new Date().toISOString()}

User:
${JSON.stringify(currentUser, null, 2)}

Request:
${task}

Return JSON in this exact format:
{
  "reminder": "what to remind the user",
  "dueAt": "ISO date time"
}
`
  );
 console.log("Reminder reply:", reply); 

  let parsed;

  try {
    parsed = JSON.parse(reply);
  } catch (err) {
    return "I understood this is a reminder, but I couldn't understand the time. Please say something like: Sky remind me in 2 minutes to call Johnson.";
  }

  await saveReminder(
  currentUser.name,
  currentUser.telegramId,
  parsed.reminder,
  parsed.dueAt,
  task
);

  return "Okay, I will remind you.";
}
if (result.createSpreadsheet) {
  const spreadsheet = await createSpreadsheetFile(currentUser, task);

  if (!spreadsheet.success) {
    return "I tried to create the spreadsheet, but got this error: " + spreadsheet.error;
  }

  return (
    "I created the spreadsheet and saved it here:\n" +
    spreadsheet.filePath
  );
}
if (result.createPDF) {
  const pdf = await createPDFFile(currentUser, task);

  if (!pdf.success) {
    return "I tried to create the PDF, but got this error: " + pdf.error;
  }

  return (
    "I created the PDF and saved it here:\n" +
    pdf.filePath
  );
}
    if (result.normalChat) {
  const reply = await askOpenAI(
    SYSTEM_PROMPT,
    `
Current user:
${JSON.stringify(currentUser, null, 2)}

User question:
${task}
`
  );

  return reply;
}
    actionHistory.push({
      step,
      tool,
      result,
    });

    if (!result.success) {
      return (
        "I tried to do " +
        tool.action +
        " but got this error: " +
        result.error
      );
    }

    if (tool.action === "describeScreen") {
      screenContext = result.description;

      if (
        task.toLowerCase().includes("what do you see") ||
        task.toLowerCase().includes("tell me what you see") ||
        task.toLowerCase().includes("look at my screen")
      ) {
        return result.description;
      }
    } else {
      screenContext = "Last action completed: " + tool.action;
    }
  }

  return "I completed the first few steps. I may need more instruction to continue.";
}
async function sendFileToTelegram(ctx, filePath, caption = "") {
  try {
    await ctx.telegram.sendDocument(
      ctx.chat.id,
      {
        source: filePath,
      },
      {
        caption,
      }
    );

    return true;
  } catch (err) {
    console.error("Telegram upload error:", err);
    return false;
  }
}

// --- Telegram message handler ---
bot.on("message:text", async (ctx) => {
  try {
    const text = ctx.message.text || "";
    const lower = text.toLowerCase().trim();

    console.log("Received message:", text);
    
    const telegramId = String(ctx.from.id);

    const currentUser = USERS[telegramId] || {
    name: ctx.from.first_name || "Unknown",
    role: "guest",
    email: null
  };

  currentUser.telegramId = String(ctx.chat.id);

console.log("User:", currentUser.name, telegramId);
    // Sky Agent Mode
if (lower.startsWith("sky ")) {
  const task = text.replace(/^sky/i, "").trim();

  const result = await runAgentTask(task, currentUser);

  return ctx.reply(result);
} 
    // Desktop test
    if (lower === "sky test desktop") {
      const result = await sendToPythonAgent({ action: "move", x: 500, y: 500 });
      if (!result.success) return ctx.reply("Desktop error: " + result.error);

      await sendToPythonAgent({ action: "click" });
      return ctx.reply("Sky clicked your desktop.");
    }

    // Screenshot
    if (lower === "sky screenshot") {
      const result = await sendToPythonAgent({ action: "screenshot" });
      if (!result.success) return ctx.reply("Screenshot error: " + result.error);

      return ctx.reply("Screenshot saved on your computer: " + result.path);
    }

    // Scroll
    if (lower === "sky scroll") {
      const result = await sendToPythonAgent({ action: "scroll", y: -500 });
      if (!result.success) return ctx.reply("Scroll error: " + result.error);

      return ctx.reply("Scrolling.");
    }

    // Right click
    if (lower === "sky right click") {
      const result = await sendToPythonAgent({ action: "rightClick" });
      if (!result.success) return ctx.reply("Right click error: " + result.error);

      return ctx.reply("Right click done.");
    }

    // Double click
    if (lower === "sky double click") {
      const result = await sendToPythonAgent({ action: "doubleClick" });
      if (!result.success) return ctx.reply("Double click error: " + result.error);

      return ctx.reply("Double click done.");
    }

    // Drag: sky drag 800 500
    if (lower.startsWith("sky drag")) {
      const parts = lower.split(" ");
      const x = parseInt(parts[2]);
      const y = parseInt(parts[3]);

      if (Number.isNaN(x) || Number.isNaN(y)) {
        return ctx.reply("Use: sky drag 800 500");
      }

      const result = await sendToPythonAgent({ action: "drag", x, y });
      if (!result.success) return ctx.reply("Drag error: " + result.error);

      return ctx.reply(`Dragging to ${x}, ${y}.`);
    }

    // Move: sky move 800 500
    if (lower.startsWith("sky move")) {
      const parts = lower.split(" ");
      const x = parseInt(parts[2]);
      const y = parseInt(parts[3]);

      if (Number.isNaN(x) || Number.isNaN(y)) {
        return ctx.reply("Use: sky move 800 500");
      }

      const result = await sendToPythonAgent({ action: "move", x, y });
      if (!result.success) return ctx.reply("Move error: " + result.error);

      return ctx.reply(`Moved to ${x}, ${y}.`);
    }

    // Click
    if (lower === "sky click") {
      const result = await sendToPythonAgent({ action: "click" });
      if (!result.success) return ctx.reply("Click error: " + result.error);

      return ctx.reply("Clicked.");
    }

    // Type: sky type hello world
    if (lower.startsWith("sky type")) {
      const textToType = text.substring(8).trim();

      if (!textToType) {
        return ctx.reply("Use: sky type your text here");
      }

      const result = await sendToPythonAgent({
        action: "type",
        text: textToType,
      });

      if (!result.success) return ctx.reply("Typing error: " + result.error);

      return ctx.reply(`Typed: ${textToType}`);
    }

    // Business search
    if (lower.startsWith("sky search")) {
      const query = text.replace(/sky search/i, "").trim();

      if (!query) {
        return ctx.reply("Use: sky search pool subcontractors Ocala");
      }

      const results = await searchBusinessOnSerpAPI(query);

      if (!results.length) {
        return ctx.reply("No results found.");
      }

      const message = results
        .slice(0, 5)
        .map(
          (b, i) =>
            `${i + 1}. ${b.name}\n${b.address}\n${b.phone}\n${b.website || b.link}`
        )
        .join("\n\n");

      return ctx.reply(message);
    }

    // Save workflow
    if (lower.startsWith("remember office workflow")) {
      const { name, steps } = parseWorkflowFromText(text);
      const saved = await saveOfficeWorkflow(name, "", steps);

      return ctx.reply(`Saved office workflow: ${saved.name}`);
    }

    // List workflows
    if (
      lower.includes("show office workflows") ||
      lower.includes("list office workflows")
    ) {
      const workflows = await listOfficeWorkflows();

      if (workflows.length === 0) {
        return ctx.reply("No office workflows saved yet.");
      }

      return ctx.reply(
        workflows.map((w) => `• ${w.name} (${w.steps.length} steps)`).join("\n")
      );
    }

    // Save rule
    if (lower.startsWith("remember office rule")) {
      const ruleText = text.replace(/remember office rule/i, "").trim();

      if (!ruleText) {
        return ctx.reply("Use: remember office rule Always collect deposit before scheduling.");
      }

      const saved = await saveOfficeRule("general", ruleText, 1);
      return ctx.reply(`Saved office rule: ${saved.rule_text}`);
    }

    // List rules
    if (lower.includes("show office rules") || lower.includes("list office rules")) {
      const rules = await listOfficeRules();

      if (rules.length === 0) {
        return ctx.reply("No office rules saved yet.");
      }

      return ctx.reply(
        rules.map((r) => `• ${r.category}: ${r.rule_text}`).join("\n")
      );
    }

    // Save preference
    if (lower.startsWith("remember office preference")) {
      const preferenceText = text
        .replace(/remember office preference/i, "")
        .trim();

      const parts = preferenceText.split(":");

      if (parts.length < 2) {
        return ctx.reply("Use: remember office preference tone: professional and friendly");
      }

      const key = parts[0].trim();
      const value = parts.slice(1).join(":").trim();

      const saved = await saveOfficePreference(key, value);
      return ctx.reply(`Saved preference: ${saved.key} = ${saved.value}`);
    }

    // List preferences
    if (
      lower.includes("show office preferences") ||
      lower.includes("list office preferences")
    ) {
      const preferences = await listOfficePreferences();

      if (preferences.length === 0) {
        return ctx.reply("No office preferences saved yet.");
      }

      return ctx.reply(
        preferences.map((p) => `• ${p.key}: ${p.value}`).join("\n")
      );
    }
// Open program command
if (lower.startsWith("sky open")) {
    const program = lower.replace("sky open", "").trim();

    if (!program) {
        return ctx.reply("Use: Sky open chrome");
    }

    const result = await sendToPythonAgent({
        action: "openProgram",
        text: program
    });

    if (!result.success) {
        return ctx.reply("Open program error: " + result.error);
    }

    return ctx.reply("Opening " + program + ".");
}
    // Hotkey command
if (lower.startsWith("sky hotkey")) {

    const keys = lower
        .replace("sky hotkey", "")
        .trim()
        .split(" ");

    if (keys.length === 0 || !keys[0]) {
        return ctx.reply("Use: sky hotkey ctrl s");
    }

    const result = await sendToPythonAgent({
        action: "hotkey",
        keys
    });

    if (!result.success) {
        return ctx.reply("Hotkey error: " + result.error);
    }

    return ctx.reply(
        "Pressed hotkey: " + keys.join(" + ")
    );
}
// Natural language secretary brain disabled

// Normal AI chat
const reply = await askOpenAI(SYSTEM_PROMPT, text);
return ctx.reply(reply);

} catch (err) {
    console.error("Bot error:", err);
    return ctx.reply("Sky had an error: " + err.message);
}
});

// --- Start HTTP server ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("HTTP server running on port " + PORT);
});

// --- Start Telegram bot ---
bot.start();
console.log("Sky is running and connected to Telegram.");