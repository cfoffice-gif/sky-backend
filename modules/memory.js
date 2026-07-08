function createMemoryModule(supabase) {
  async function saveMemory(userName, category, memory) {
    const { error } = await supabase.from("memories").insert([
      { user_name: userName, category, memory }
    ]);

    if (error) console.error("Memory insert error:", error);
  }

  async function getMemories(userName) {
    const { data, error } = await supabase
      .from("memories")
      .select("*")
      .eq("user_name", userName)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) console.error("Memory fetch error:", error);
    return data || [];
  }

  async function savePreference(userId, key, value) {
    const { error } = await supabase.from("preferences").insert({
      user_id: String(userId || ""),
      key,
      value: typeof value === "string" ? value : JSON.stringify(value)
    });

    if (error) console.error("Preference insert error:", error);
  }

  async function getPreferences(userId) {
    const { data, error } = await supabase
      .from("preferences")
      .select("*")
      .eq("user_id", String(userId || ""))
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) console.error("Preference fetch error:", error);
    return data || [];
  }

  async function saveReminder(userName, reminder, dueAt, telegramId = "") {
    const { error } = await supabase.from("reminders").insert([
      {
        user_name: userName,
        telegram_id: String(telegramId || ""),
        reminder,
        due_at: dueAt,
        completed: false,
        sent: false
      }
    ]);

    if (error) console.error("Reminder insert error:", error);
  }

  async function getDueReminders() {
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("reminders")
      .select("*")
      .lte("due_at", now)
      .eq("completed", false);

    if (error) console.error("Due reminders fetch error:", error);
    return data || [];
  }

  async function markReminderSent(id) {
    const { error } = await supabase
      .from("reminders")
      .update({ sent: true })
      .eq("id", id);

    if (error) console.error("Reminder update error:", error);
  }

  async function saveFileMemory(userName, fileType, fileName, filePath, description) {
    const { error } = await supabase.from("files").insert([
      {
        user_name: userName,
        file_type: fileType,
        file_name: fileName,
        file_path: filePath,
        description
      }
    ]);

    if (error) console.error("File memory insert error:", error);
  }

  return {
    saveMemory,
    getMemories,
    savePreference,
    getPreferences,
    saveReminder,
    getDueReminders,
    markReminderSent,
    saveFileMemory
  };
}

module.exports = {
  createMemoryModule
};
