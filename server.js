import "dotenv/config";
import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import axios from "axios";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// 🔹 Load DeepSeek API Key
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Generate AI Summary Using DeepSeek (100 Words)
const generateSummary = async (text) => {
  try {
    console.log(" Sending extracted text to DeepSeek for summarization...");

    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "You are an AI assistant that generates summaries with exactly 100 words.",
          },
          {
            role: "user",
            content: `Summarize the following text in exactly 100 words:
            
            Text: """${text}"""

            **Output format:**
            \`\`\`
            <summary>Generated summary here...</summary>
            \`\`\`
            
            **Rules:**
            - Summary must be exactly 100 words.
            - No extra text outside the summary.
            - No bullet points or numbered lists.
            `,
          },
        ],
        stream: false,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
      }
    );

    // Extract the response text
    const responseText = response.data.choices[0].message.content.trim();

    // Extract summary from response
    const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/);

    if (!summaryMatch) {
      throw new Error("DeepSeek response does not contain a summary.");
    }

    console.log(" DeepSeek Summary Response:", summaryMatch[1]);
    return summaryMatch[1];
  } catch (error) {
    console.error(
      " DeepSeek Summary Error:",
      error.response?.data || error.message
    );
    return "Error generating summary.";
  }
};

//  Generate AI Questions Using DeepSeek (Short-Answer)
const generateQuestionsFromText = async (text) => {
  try {
    console.log(
      " Sending extracted text to DeepSeek for short-answer question generation..."
    );

    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "You are an AI assistant that generates only short-answer quiz questions in JSON format.",
          },
          {
            role: "user",
            content: `Generate 10 short-answer quiz questions in strict JSON format based on the following text:
            
            Text: """${text}"""

            **Output must be a valid JSON inside triple backticks like this:**
            \`\`\`json
            {
              "questions": [
                {"type": "short-answer", "question": "...", "answer": "..."},
                {"type": "short-answer", "question": "...", "answer": "..."},
                {"type": "short-answer", "question": "...", "answer": "..."}
              ]
            }
            \`\`\`
            
            **Rules:**
            - Only generate **short-answer** questions.
            - Do **not** include multiple-choice or true/false questions.
            - Output must strictly follow the JSON format above.
            - Do **not** include any text outside the JSON block.
            `,
          },
        ],
        stream: false,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
      }
    );

    // Extract the response text
    const responseText = response.data.choices[0].message.content.trim();

    // Extract JSON block from response
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);

    if (!jsonMatch) {
      throw new Error("DeepSeek response is not in JSON format.");
    }

    // Parse JSON
    const output = JSON.parse(jsonMatch[1]);

    console.log("🔍 DeepSeek Short-Answer Question Response:", output);
    return output.questions;
  } catch (error) {
    console.error(" DeepSeek Error:", error.response?.data || error.message);
    return ["Error generating short-answer questions from text."];
  }
};

//  Process File (Handles PDF/DOCX Extraction & AI Processing)
const processFile = async (req, res, extractTextFunc) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = path.resolve(req.file.path);
    console.log(` Processing File: ${req.file.originalname}`);

    const text = await extractTextFunc(filePath);

    //  Log the extracted text
    console.log(" Extracted Text:", text);

    if (!text.trim()) {
      await fs.unlink(filePath);
      return res.status(400).json({ error: "Extracted text is empty." });
    }

    const [summary, questions] = await Promise.all([
      generateSummary(text),
      generateQuestionsFromText(text),
    ]);

    await fs.unlink(filePath); // Delete file after processing
    res.json({ summary, questions });
  } catch (error) {
    console.error(" Error processing file:", error.message);
    res.status(500).json({ error: "Failed to process file" });
  }
};

//  Handle PDF Upload & AI Processing
app.post(
  "/summarize/pdf",
  multer({ dest: "uploads/" }).single("file"),
  async (req, res) => {
    processFile(req, res, async (filePath) => {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    });
  }
);

//  Handle DOCX Upload & AI Processing
app.post(
  "/summarize/docx",
  multer({ dest: "uploads/" }).single("file"),
  async (req, res) => {
    processFile(req, res, async (filePath) => {
      const dataBuffer = await fs.readFile(filePath);
      const { value: text } = await mammoth.extractRawText({
        buffer: dataBuffer,
      });
      return text;
    });
  }
);

// 🔹 Start the Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(` Server running on port ${PORT}`));
