(function () {
    const BACKEND_URL = "https://ai-chatbot-two-neon-63.vercel.app/api/chat";

    const config = window.ChatbotConfig || {};
    const systemPrompt = config.systemPrompt || "You are a helpful assistant.";
    const primaryColor = config.primaryColor || "#6366f1";
    const botName = config.botName || "AI Assistant";

    // Inject styles
    const style = document.createElement("style");
    style.innerHTML = `
    #chatbot-bubble {
      position: fixed; bottom: 24px; right: 24px;
      width: 56px; height: 56px; border-radius: 50%;
      background: ${primaryColor}; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 9999;
      border: none; outline: none;
    }
    #chatbot-bubble svg { width: 28px; height: 28px; fill: white; }
    #chatbot-box {
      display: none; position: fixed; bottom: 90px; right: 24px;
      width: 360px; height: 500px; border-radius: 16px;
      background: #fff; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      z-index: 9999; flex-direction: column; overflow: hidden;
      font-family: sans-serif;
    }
    #chatbot-box.open { display: flex; }
    #chatbot-header {
      background: ${primaryColor}; color: white;
      padding: 16px; font-weight: bold; font-size: 15px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #chatbot-close {
      background: none; border: none; color: white;
      font-size: 20px; cursor: pointer;
    }
    #chatbot-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .cb-msg {
      max-width: 80%; padding: 10px 14px;
      border-radius: 12px; font-size: 14px; line-height: 1.5;
    }
    .cb-msg.user {
      background: ${primaryColor}; color: white;
      align-self: flex-end; border-bottom-right-radius: 4px;
    }
    .cb-msg.bot {
      background: #f1f1f1; color: #333;
      align-self: flex-start; border-bottom-left-radius: 4px;
    }
    .cb-msg.typing { color: #999; font-style: italic; }
    #chatbot-input-area {
      display: flex; padding: 12px; border-top: 1px solid #eee; gap: 8px;
    }
    #chatbot-input {
      flex: 1; padding: 10px 14px; border-radius: 24px;
      border: 1px solid #ddd; outline: none; font-size: 14px;
    }
    #chatbot-send {
      background: ${primaryColor}; color: white;
      border: none; border-radius: 50%; width: 40px; height: 40px;
      cursor: pointer; font-size: 18px; display: flex;
      align-items: center; justify-content: center;
    }
  `;
    document.head.appendChild(style);

    // HTML
    document.body.insertAdjacentHTML("beforeend", `
    <button id="chatbot-bubble">
      <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.07-1.36A9.94 9.94 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z"/></svg>
    </button>
    <div id="chatbot-box">
      <div id="chatbot-header">
        <span>${botName}</span>
        <button id="chatbot-close">✕</button>
      </div>
      <div id="chatbot-messages"></div>
      <div id="chatbot-input-area">
        <input id="chatbot-input" type="text" placeholder="Type a message..." />
        <button id="chatbot-send">➤</button>
      </div>
    </div>
  `);

    const box = document.getElementById("chatbot-box");
    const messages = document.getElementById("chatbot-messages");
    const input = document.getElementById("chatbot-input");

    document.getElementById("chatbot-bubble").onclick = () => box.classList.toggle("open");
    document.getElementById("chatbot-close").onclick = () => box.classList.remove("open");
    document.getElementById("chatbot-send").onclick = sendMessage;
    input.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });

    function addMessage(text, role) {
        const div = document.createElement("div");
        div.className = `cb-msg ${role}`;
        div.textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div;
    }

    async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        addMessage(text, "user");

        const botDiv = addMessage("", "bot");
        let fullText = "";

        try {
            const res = await fetch(BACKEND_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text, systemPrompt })
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split("\n");

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        const data = line.replace("data: ", "").trim();
                        if (data === "[DONE]") break;
                        try {
                            const parsed = JSON.parse(data);
                            fullText += parsed.text;
                            botDiv.textContent = fullText;
                            messages.scrollTop = messages.scrollHeight;
                        } catch {}
                    }
                }
            }
        } catch {
            botDiv.textContent = "Something went wrong. Try again.";
        }
    }
})();