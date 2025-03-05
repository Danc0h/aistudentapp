import "dotenv/config";
import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import axios from "axios";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import FormData from "form-data";
import Note from "./models/NotesModel.js";

const app = express();

// 🔹 Load environment variables
const MONGO_URI = process.env.MONGODB_URI;
const NLP_CLOUD_API_KEY = process.env.NLP_CLOUD_API_KEY;

// 🔹 Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

app.use(express.json());
app.use(cors());

// 🔹 Set up file upload with multer
const upload = multer({ dest: "uploads/" });

// 📌 Function to Generate AI Summary Using NLP Cloud
const generateSummary = async (text) => {
  try {
    // 🔹 Limit input to avoid "Request Entity Too Large" errors
    const maxTokens = 2048; // Increased max length for better summaries
    const shortenedText = text.slice(0, maxTokens);

    const response = await axios.post(
      "https://api.nlpcloud.io/v1/bart-large-cnn/summarization",
      {
        text: shortenedText,
        min_length: 200, // ✅ Ensure summary isn’t too short
        max_length: 500, // ✅ Allow longer summaries
      },
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
    console.error(
      "❌ NLP Cloud Summary Error:",
      error.response?.data || error.message
    );
    return "Error generating summary.";
  }
};

/*
// 📌 Function to Generate AI Questions Using NLP Cloud
const generateQuestions = async (text) => {
  try {
    // 🔹 Limit text length for NLP Cloud to avoid "Request Entity Too Large"
    const maxTokens = 1024;
    const shortenedText = text.slice(0, maxTokens);

    const response = await axios.post(
      "https://api.nlpcloud.io/v1/bart-large-cnn/summarization",
      {
        text: `Generate 5 study questions from this text:\n\n${shortenedText}`,
        min_length: 50,
        max_length: 200,
      },
      {
        headers: {
          Authorization: `Token ${NLP_CLOUD_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("🔍 NLP Cloud Question Response:", response.data);

    if (!response.data || !response.data.generated_text) {
      return ["AI did not return valid questions."];
    }

    return response.data.generated_text.split("\n").filter(Boolean);
  } catch (error) {
    console.error(
      "❌ NLP Cloud Question Error:",
      error.response?.data || error.message
    );
    return ["Error generating questions."];
  }
};*/

const PREP_AI_CLIENT_ID = process.env.PREP_AI_CLIENT_ID;
const PREP_AI_CLIENT_SECRET = process.env.PREP_AI_CLIENT_SECRET;

const generateQuestions = async (text) => {
  try {
    // 🔹 Reduce text length if necessary to avoid API limitations
    const maxTokens = 1024;
    const shortenedText = text.slice(0, maxTokens);

    // 🔹 Create FormData (required by PrepAI API)
    const formData = new FormData();
    formData.append("quizName", "Generated Quiz");
    formData.append("content", shortenedText);
    formData.append("quesType", "1,5"); // Question types (1=MCQ, 5=Short Answer)
    formData.append("quesCount", "5"); // Request 5 questions
    formData.append("visualOutput", "1"); // Include visual formatting

    const response = await axios.post(
      "https://api.prepai.io/generateQuestionsApi",
      formData,
      {
        headers: {
          clientId: PREP_AI_CLIENT_ID, // ✅ Correct case
          clientSecret: PREP_AI_CLIENT_SECRET, // ✅ Correct case
          ...formData.getHeaders(), // ✅ Required for FormData
        },
      }
    );

    console.log("🔍 PrepAI Question Response:", response.data);

    if (!response.data || !response.data.questions) {
      return ["PrepAI did not return valid questions."];
    }

    return response.data.questions;
  } catch (error) {
    console.error(
      "❌ PrepAI Question Error:",
      error.response?.data || error.message
    );
    return ["Error generating questions."];
  }
};

// 📌 Function to Process a File (Common for PDF & DOCX)
const processFile = async (req, res, extractTextFunc) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = path.resolve(req.file.path);
    const text = await extractTextFunc(filePath);

    if (!text || text.trim().length === 0) {
      await fs.unlink(filePath); // Cleanup
      return res.status(400).json({
        error: "Extracted text is empty. Please upload a valid document.",
      });
    }

    console.log("📢 Processing File...");

    // AI Processing
    const summary = await generateSummary(text);
    const questions = await generateQuestions(text);

    // Save to MongoDB
    const newNote = new Note({
      filename: req.file.originalname,
      fileType: req.file.mimetype,
      textContent: text,
      summary,
      generatedQuestions: questions,
    });

    await newNote.save();

    // ✅ Delete file after processing
    await fs.unlink(filePath);

    res.json({ summary, questions });
  } catch (error) {
    console.error("❌ Error processing file:", error.message);
    res.status(500).json({ error: "Failed to process file" });
  }
};

// 📌 Handle PDF Upload & AI Processing
app.post("/summarize/pdf", upload.single("file"), async (req, res) => {
  processFile(req, res, async (filePath) => {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text; // Return full text
  });
});

// 📌 Handle DOCX Upload & AI Processing
app.post("/summarize/docx", upload.single("file"), async (req, res) => {
  processFile(req, res, async (filePath) => {
    const dataBuffer = await fs.readFile(filePath);
    const { value: text } = await mammoth.extractRawText({
      buffer: dataBuffer,
    });
    return text;
  });
});

// 📌 Fetch All Saved Notes
app.get("/notes", async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 });
    res.json(notes);
  } catch (error) {
    console.error("❌ Fetching notes error:", error.message);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Start the Server
app.listen(5000, () => console.log("✅ Server running on port 5000"));
