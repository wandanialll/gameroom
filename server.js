const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const SNAP_THRESHOLD = 28; // px — how close to correct position to lock
const ROOM_TTL_MS = 90 * 60 * 1000; // 90 min idle cleanup
const MAX_IMAGE_DIM = 1200; // resize uploads to this max dimension

// ─── In-memory room store ────────────────────────────────────────────────────
// Map<roomId, Room>
// Room = { id, hostNickname, imageFile, cols, rows, pieceCount, pieces[], players{}, timer, complete }
// Piece = { id, col, row, correctX, correctY, x, y, locked, heldBy }
const rooms = new Map();

// ─── Dirs ────────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PIECES_DIR = path.join(__dirname, "public", "pieces");
const COMPLETED_DIR = path.join(__dirname, "public", "completed");
[UPLOAD_DIR, PIECES_DIR, COMPLETED_DIR].forEach((d) =>
	fs.mkdirSync(d, { recursive: true }),
);

// ─── Multer ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
	destination: UPLOAD_DIR,
	filename: (_, file, cb) =>
		cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
	storage,
	limits: { fileSize: 5 * 1024 * 1024 },
	fileFilter: (_, file, cb) => {
		if (file.mimetype.startsWith("image/")) cb(null, true);
		else cb(new Error("Images only"));
	},
});

// ─── Static ──────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
	return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffle(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function scheduleRoomCleanup(roomId) {
	const room = rooms.get(roomId);
	if (!room) return;
	if (room.timer) clearTimeout(room.timer);
	room.timer = setTimeout(() => {
		cleanupRoom(roomId);
	}, ROOM_TTL_MS);
}

function cleanupRoom(roomId) {
	const room = rooms.get(roomId);
	if (!room) return;
	// Delete piece images
	const pieceDir = path.join(PIECES_DIR, roomId);
	fs.rm(pieceDir, { recursive: true, force: true }, () => {});
	// Delete uploaded original
	if (room.imageFile) fs.unlink(room.imageFile, () => {});
	rooms.delete(roomId);
	console.log(`[cleanup] Room ${roomId} removed`);
}

// ─── Slice image into pieces ─────────────────────────────────────────────────
async function sliceImage(imagePath, roomId, cols, rows) {
	const pieceDir = path.join(PIECES_DIR, roomId);
	fs.mkdirSync(pieceDir, { recursive: true });

	// Resize image to fit nicely
	const resized = await sharp(imagePath)
		.resize(MAX_IMAGE_DIM, MAX_IMAGE_DIM, {
			fit: "inside",
			withoutEnlargement: true,
		})
		.toBuffer({ resolveWithObject: true });

	const { width, height } = resized.info;
	const pieceW = Math.floor(width / cols);
	const pieceH = Math.floor(height / rows);

	const pieces = [];

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const id = row * cols + col;
			const left = col * pieceW;
			const top = row * pieceH;
			const extractWidth = col === cols - 1 ? width - left : pieceW;
			const extractHeight = row === rows - 1 ? height - top : pieceH;
			const outFile = path.join(pieceDir, `${id}.jpg`);

			await sharp(resized.data)
				.extract({ left, top, width: extractWidth, height: extractHeight })
				.jpeg({ quality: 85 })
				.toFile(outFile);

			pieces.push({ id, col, row, correctX: left, correctY: top });
		}
	}

	return { pieces, pieceW, pieceH, boardW: width, boardH: height };
}

// ─── Scatter pieces randomly ──────────────────────────────────────────────────
function scatterPieces(pieces, pieceW, pieceH, boardW, boardH) {
	const CANVAS_W = boardW + 400; // extra scatter area
	const CANVAS_H = boardH + 400;

	return shuffle([...pieces]).map((p, i) => ({
		...p,
		x: Math.random() * (CANVAS_W - pieceW),
		y: Math.random() * (CANVAS_H - pieceH),
		locked: false,
		heldBy: null,
	}));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Create room
app.post("/api/create", upload.single("image"), async (req, res) => {
	try {
		const { nickname, pieceCount } = req.body;
		if (!req.file) return res.status(400).json({ error: "No image uploaded" });
		if (!nickname || !nickname.trim())
			return res.status(400).json({ error: "Nickname required" });

		const count = Math.max(4, Math.min(400, parseInt(pieceCount) || 25));
		// Find best grid ratio for the piece count
		const cols = Math.round(Math.sqrt(count * (4 / 3)));
		const rows = Math.round(count / cols);
		const actualCount = cols * rows;

		const roomId = generateRoomCode();

		const { pieces, pieceW, pieceH, boardW, boardH } = await sliceImage(
			req.file.path,
			roomId,
			cols,
			rows,
		);

		const scattered = scatterPieces(pieces, pieceW, pieceH, boardW, boardH);

		const room = {
			id: roomId,
			hostNickname: nickname.trim(),
			imageFile: req.file.path,
			cols,
			rows,
			pieceCount: actualCount,
			pieceW,
			pieceH,
			boardW,
			boardH,
			pieces: scattered,
			players: {},
			timer: null,
			complete: false,
			completedAt: null,
			completedImage: null,
			createdAt: Date.now(),
		};

		rooms.set(roomId, room);
		scheduleRoomCleanup(roomId);

		res.json({ roomId, pieceCount: actualCount, cols, rows });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.message });
	}
});

// Room info (for joining)
app.get("/api/room/:id", (req, res) => {
	const room = rooms.get(req.params.id.toUpperCase());
	if (!room)
		return res.status(404).json({ error: "Room not found or expired" });
	res.json({
		id: room.id,
		pieceCount: room.pieceCount,
		cols: room.cols,
		rows: room.rows,
		pieceW: room.pieceW,
		pieceH: room.pieceH,
		boardW: room.boardW,
		boardH: room.boardH,
		complete: room.complete,
		completedImage: room.completedImage,
		playerCount: Object.keys(room.players).length,
	});
});

// Serve room page
app.get("/room/:id", (_, res) => {
	res.sendFile(path.join(__dirname, "public", "room.html"));
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

// Assign a color to each player
const PLAYER_COLORS = [
	"#FF6B6B",
	"#4ECDC4",
	"#45B7D1",
	"#96CEB4",
	"#FFEAA7",
	"#DDA0DD",
	"#98D8C8",
	"#F7DC6F",
	"#BB8FCE",
	"#85C1E9",
];

io.on("connection", (socket) => {
	let currentRoom = null;
	let currentNickname = null;
	let colorIndex = 0;

	socket.on("join_room", ({ roomId, nickname }) => {
		roomId = (roomId || "").toUpperCase();
		const room = rooms.get(roomId);
		if (!room) {
			socket.emit("error", { message: "Room not found or expired" });
			return;
		}

		currentRoom = roomId;
		currentNickname = (nickname || "Anonymous").trim().substring(0, 20);

		// Assign color
		const usedColors = Object.values(room.players).map((p) => p.color);
		const available = PLAYER_COLORS.filter((c) => !usedColors.includes(c));
		const color =
			available[0] ||
			PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];

		room.players[socket.id] = {
			id: socket.id,
			nickname: currentNickname,
			color,
			score: 0,
		};
		socket.join(roomId);

		// Reset cleanup timer (room is active)
		scheduleRoomCleanup(roomId);

		// Send full game state to the joining player
		socket.emit("game_state", {
			pieces: room.pieces,
			players: room.players,
			pieceW: room.pieceW,
			pieceH: room.pieceH,
			boardW: room.boardW,
			boardH: room.boardH,
			cols: room.cols,
			rows: room.rows,
			complete: room.complete,
			completedImage: room.completedImage,
			myId: socket.id,
			myColor: color,
		});

		// Notify others
		socket
			.to(roomId)
			.emit("player_joined", { player: room.players[socket.id] });
		io.to(roomId).emit("players_update", { players: room.players });

		console.log(`[join] ${currentNickname} joined room ${roomId}`);
	});

	// Player picks up a piece
	socket.on("piece_grab", ({ pieceId }) => {
		const room = rooms.get(currentRoom);
		if (!room || room.complete) return;
		const piece = room.pieces.find((p) => p.id === pieceId);
		if (!piece || piece.locked || piece.heldBy) return;

		piece.heldBy = socket.id;
		socket.to(currentRoom).emit("piece_grabbed", {
			pieceId,
			heldBy: socket.id,
			color: room.players[socket.id]?.color,
		});
	});

	// Player moves a piece
	socket.on("piece_move", ({ pieceId, x, y }) => {
		const room = rooms.get(currentRoom);
		if (!room || room.complete) return;
		const piece = room.pieces.find((p) => p.id === pieceId);
		if (!piece || piece.locked || piece.heldBy !== socket.id) return;

		piece.x = x;
		piece.y = y;

		socket
			.to(currentRoom)
			.emit("piece_moved", { pieceId, x, y, movedBy: socket.id });
	});

	// Player drops a piece
	socket.on("piece_drop", ({ pieceId, x, y }) => {
		const room = rooms.get(currentRoom);
		if (!room || room.complete) return;
		const piece = room.pieces.find((p) => p.id === pieceId);
		if (!piece || piece.locked || piece.heldBy !== socket.id) return;

		piece.x = x;
		piece.y = y;
		piece.heldBy = null;

		// Check snap
		const dx = Math.abs(x - piece.correctX);
		const dy = Math.abs(y - piece.correctY);
		let locked = false;

		if (dx <= SNAP_THRESHOLD && dy <= SNAP_THRESHOLD) {
			piece.x = piece.correctX;
			piece.y = piece.correctY;
			piece.locked = true;
			locked = true;

			// Credit the player
			if (room.players[socket.id]) {
				room.players[socket.id].score += 1;
			}

			io.to(currentRoom).emit("players_update", { players: room.players });
		}

		io.to(currentRoom).emit("piece_dropped", {
			pieceId,
			x: piece.x,
			y: piece.y,
			locked,
			lockedBy: locked ? socket.id : null,
			color: room.players[socket.id]?.color,
		});

		// Check if puzzle complete
		if (locked) {
			const allLocked = room.pieces.every((p) => p.locked);
			if (allLocked) {
				handleCompletion(room);
			}
		}
	});

	// Release piece without dropping (e.g., disconnect mid-drag)
	function releasePieces() {
		const room = rooms.get(currentRoom);
		if (!room) return;
		room.pieces.forEach((p) => {
			if (p.heldBy === socket.id) {
				p.heldBy = null;
				io.to(currentRoom).emit("piece_released", { pieceId: p.id });
			}
		});
	}

	socket.on("disconnect", () => {
		releasePieces();
		const room = rooms.get(currentRoom);
		if (room) {
			delete room.players[socket.id];
			io.to(currentRoom).emit("player_left", { playerId: socket.id });
			io.to(currentRoom).emit("players_update", { players: room.players });

			// If room is empty, schedule faster cleanup
			if (Object.keys(room.players).length === 0) {
				scheduleRoomCleanup(currentRoom);
			}
		}
	});
});

// ─── Puzzle completion ────────────────────────────────────────────────────────
async function handleCompletion(room) {
	if (room.complete) return;
	room.complete = true;
	room.completedAt = Date.now();

	try {
		// Reconstruct image from pieces using sharp composite
		const pieceDir = path.join(PIECES_DIR, room.id);
		const composites = room.pieces.map((p) => ({
			input: path.join(pieceDir, `${p.id}.jpg`),
			left: p.correctX,
			top: p.correctY,
		}));

		const outFile = `${room.id}-completed.jpg`;
		const outPath = path.join(COMPLETED_DIR, outFile);

		await sharp({
			create: {
				width: room.boardW,
				height: room.boardH,
				channels: 3,
				background: { r: 255, g: 255, b: 255 },
			},
		})
			.composite(composites)
			.jpeg({ quality: 90 })
			.toFile(outPath);

		room.completedImage = `/completed/${outFile}`;

		// Clean up piece images to free disk
		fs.rm(pieceDir, { recursive: true, force: true }, () => {});

		io.to(room.id).emit("puzzle_complete", {
			completedImage: room.completedImage,
			players: room.players,
			duration: Math.round((room.completedAt - room.createdAt) / 1000),
		});

		console.log(`[complete] Room ${room.id} puzzle completed!`);
	} catch (err) {
		console.error("[completion error]", err);
		io.to(room.id).emit("puzzle_complete", {
			completedImage: null,
			players: room.players,
		});
	}
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
	console.log(`🧩 Jigsaw server running on port ${PORT}`);
});
