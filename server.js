import "dotenv/config";
import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import axios from "axios";
import cors from "cors";
import fs from "fs/promises"; // ✅ Use fs/promises for async file operations
import path from "path";
import mongoose from "mongoose";
import Note from "./models/NotesModel.js";

const app = express();

// 🔹 Load environment variables
const MONGO_URI = process.env.MONGODB_URI;
const NLP_CLOUD_API_KEY = process.env.NLP_CLOUD_API_KEY;
const PREP_AI_CLIENT_ID = process.env.PREP_AI_CLIENT_ID;
const PREP_AI_CLIENT_SECRET = process.env.PREP_AI_CLIENT_SECRET;

// 🔹 Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

app.use(express.json());
app.use(cors());

// 🔹 Set up file upload with multer
const upload = multer({ dest: "uploads/" });

/**
 * 📌 Function to Generate AI Summary Using NLP Cloud with Retry (Handles 429 Errors)
 */
const generateSummary = async (text) => {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      console.log(
        "📤 Sending extracted text to NLP Cloud for summarization..."
      );
      const response = await axios.post(
        "https://api.nlpcloud.io/v1/bart-large-cnn/summarization",
        { text, min_length: 200, max_length: 500 },
        {
          headers: {
            Authorization: `Token ${NLP_CLOUD_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("🔍 NLP Cloud Summary Response:", response.data);
      return response.data.summary || "Summary generation failed.";
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(
          `⚠️ Rate limit hit. Retrying in ${attempt + 1} seconds...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, (attempt + 1) * 1000)
        );
        attempt++;
      } else {
        console.error("❌ NLP Cloud Summary Error:", error.message);
        return "Error generating summary.";
      }
    }
  }
  return "Error: Exceeded max retries for summary.";
};

/**
 * 📌 Function to Generate AI Questions from Text Using PrepAI
 */
const generateQuestionsFromText = async (text) => {
  try {
    console.log(
      "📤 Sending extracted text to PrepAI for question generation..."
    );

    const formData = new URLSearchParams();
    formData.append("quizName", "Generated Quiz");
    formData.append("content", text);
    formData.append("quesType", "1,5"); // ✅ MCQs & Short Answer
    formData.append("quesCount", "5"); // ✅ Request 5 questions
    formData.append("visualOutput", "1");

    const response = await axios.post(
      "https://api.prepai.io/generateQuestionsApi",
      formData.toString(),
      {
        headers: {
          clientId: PREP_AI_CLIENT_ID,
          clientSecret: PREP_AI_CLIENT_SECRET,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("🔍 PrepAI Question Response:", response.data);

    if (!response.data.success || !response.data.response) {
      return ["PrepAI did not return valid questions."];
    }

    return response.data.response.map((q) => q.question.join(" ")); // ✅ Convert to array of strings
  } catch (error) {
    console.error("❌ PrepAI Text-Based Question Error:", error.message);
    return ["Error generating questions from text."];
  }
};

/**
 * 📌 Common Function to Process File Uploads (PDF & DOCX)
 */
const processFile = async (req, res, extractTextFunc) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = path.resolve(req.file.path);
    console.log(`📢 Processing File: ${req.file.originalname}`);

    // ✅ Extract text
    const text = await extractTextFunc(filePath);
    if (!text.trim()) {
      await fs.unlink(filePath);
      return res.status(400).json({ error: "Extracted text is empty." });
    }

    // ✅ Generate AI Summary
    const summary = await generateSummary(text);

    // ✅ Generate AI Questions
    const questions = await generateQuestionsFromText(text);

    // ✅ Save to MongoDB
    const newNote = new Note({
      filename: req.file.originalname,
      fileType: req.file.mimetype,
      textContent: text,
      summary,
      generatedQuestions: questions,
    });

    await newNote.save();
    await fs.unlink(filePath); // ✅ Delete file after processing

    res.json({ summary, questions });
  } catch (error) {
    console.error("❌ Error processing file:", error.message);
    res.status(500).json({ error: "Failed to process file" });
  }
};

/**
 * 📌 Handle PDF Upload & AI Processing
 */
app.post("/summarize/pdf", upload.single("file"), async (req, res) => {
  processFile(req, res, async (filePath) => {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  });
});

/**
 * 📌 Handle DOCX Upload & AI Processing
 */
app.post("/summarize/docx", upload.single("file"), async (req, res) => {
  processFile(req, res, async (filePath) => {
    const dataBuffer = await fs.readFile(filePath);
    const { value: text } = await mammoth.extractRawText({
      buffer: dataBuffer,
    });
    return text;
  });
});

/**
 * 📌 Fetch All Saved Notes
 */
app.get("/notes", async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 });
    res.json(notes);
  } catch (error) {
    console.error("❌ Fetching notes error:", error.message);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

/**
 * 📌 Start the Server
 */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
