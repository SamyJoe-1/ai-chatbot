const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { message, systemPrompt } = req.body;

    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemPrompt || "You are a helpful assistant.",
        });

        const result = await model.generateContent(message);
        const response = result.response.text();

        return res.status(200).json({ reply: response });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};