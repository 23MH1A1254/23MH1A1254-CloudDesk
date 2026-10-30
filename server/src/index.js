
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:8080"
  })
);

app.use(express.json());

// Check API and database connection
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      app: "CloudDesk",
      database: "connected"
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// Get all tickets
app.get("/api/tickets", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, status, created_at
       FROM tickets
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Loading tickets failed:", error.message);

    res.status(500).json({
      error: "Unable to load tickets"
    });
  }
});

// Create a ticket
app.post("/api/tickets", async (req, res) => {
  const { title, description = "" } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      error: "Ticket title is required"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tickets (title, description)
       VALUES ($1, $2)
       RETURNING id, title, description, status, created_at`,
      [title.trim(), String(description)]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Creating ticket failed:", error.message);

    res.status(500).json({
      error: "Unable to create ticket"
    });
  }
});

// Update ticket status
app.patch("/api/tickets/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;

  const allowedStatuses = ["Open", "In Progress", "Resolved"];

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid ticket ID"
    });
  }

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid status"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE tickets
       SET status = $1
       WHERE id = $2
       RETURNING id, title, description, status, created_at`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Ticket not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Status update failed:", error.message);

    res.status(500).json({
      error: "Unable to update ticket status"
    });
  }
});

// Delete a ticket
app.delete("/api/tickets/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid ticket ID"
    });
  }

  try {
    const result = await pool.query(
      "DELETE FROM tickets WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Ticket not found"
      });
    }

    res.json({
      message: "Ticket deleted successfully",
      id: result.rows[0].id
    });
  } catch (error) {
    console.error("Deleting ticket failed:", error.message);

    res.status(500).json({
      error: "Unable to delete ticket"
    });
  }
});

// Start server
async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status VARCHAR(30) NOT NULL DEFAULT 'Open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  app.listen(port, "0.0.0.0", () => {
    console.log("CloudDesk API listening on port " + port);
  });
}

start().catch(error => {
  console.error("CloudDesk startup failed:", error.message);
  process.exit(1);
});
