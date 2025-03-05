import mongoose from "mongoose";

const NoteSchema = new mongoose.Schema({
  filename: String,
  fileType: String,
  textContent: String,
  summary: String,
  generatedQuestions: [String], // Store questions as an array
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Note", NoteSchema);
