require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getCache, setCache } = require('./cache');

const app = express();
app.use(express.json());

const loadPrompt = (serviceType) => {
  const filePath = path.join(__dirname, 'rules', `${serviceType}.txt`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
};

app.post('/chat', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${process.env.SECRET_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    prompt,
    stream = false,
    model,
    temperature,
    max_tokens,
    service_type = 'cafe',
    customer_name,
    customer_phone,
    source_data        // array of item objects — dynamic keys per service
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  // --- CACHE CHECK (exact match after normalization) ---
  const cached = await getCache(service_type, prompt);
  if (cached) {
    return res.json({ response: cached, from_cache: true });
  }

  // --- LOAD PROMPT TEMPLATE ---
  const rawPrompt = loadPrompt(service_type);
  if (!rawPrompt) {
    return res.status(400).json({ error: `No rules found for service_type: ${service_type}` });
  }

  // --- BUILD source_data string for injection ---
  // Serialize whatever dynamic shape we receive — AI reads it as JSON
  const sourceDataStr = source_data
      ? JSON.stringify(source_data, null, 2)
      : 'No menu data provided.';

  const finalPrompt = rawPrompt
      .replace('{{customer_name}}', customer_name || 'not provided')
      .replace('{{customer_phone}}', customer_phone || 'not provided')
      .replace('{{source_data}}', sourceDataStr)
      .replace('{{user_message}}', prompt);

  try {
    const payload = {
      model: model || process.env.OLLAMA_MODEL,
      prompt: finalPrompt,
      stream,
      options: {
        ...(temperature !== undefined && { temperature }),
        ...(max_tokens !== undefined && { num_predict: max_tokens }),
      }
    };

    const result = await axios.post(`${process.env.OLLAMA_URL}/api/generate`, payload, {
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      result.data.pipe(res);
    } else {
      // Take first line only — pipeline response is always one line
      const response = result.data.response.split('\n')[0].trim();

      // --- STORE IN CACHE ---
      await setCache(service_type, prompt, response);

      res.json({ response, from_cache: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Ollama failed', detail: err.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`AI API running on port ${process.env.PORT}`);
});