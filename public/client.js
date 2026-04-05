// ─── State ────────────────────────────────────────────────────────────────────
const roomId = window.location.pathname.split("/").pop().toUpperCase();
let nickname = sessionStorage.getItem("nickname") || "";
let socket = null;
let myId = null;
let myColor = "#FF6B6B";

let gameState = null; // full state from server
let pieces = []; // local piece array (mirrored from server)
let players = {};
let referenceImageUrl = "";
let referenceVisible = sessionStorage.getItem("showReference") === "1";

// Canvas / viewport
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const wrap = document.getElementById("canvas-wrap");

let viewX = 0,
	viewY = 0; // pan offset
let scale = 1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const REMOTE_LERP = 0.35;
const REMOTE_SNAP_EPSILON = 0.35;

// Drag state
let heldPieceId = null;
let heldGroupId = null;
let dragOffsetX = 0,
	dragOffsetY = 0;
let lastMouseX = 0,
	lastMouseY = 0;

// Piece image cache
const pieceImages = {}; // pieceId -> HTMLImageElement

// Pan state
let isPanning = false;
let panStartX = 0,
	panStartY = 0;
let panViewX = 0,
	panViewY = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function worldToCanvas(wx, wy) {
	return { x: wx * scale + viewX, y: wy * scale + viewY };
}

function canvasToWorld(cx, cy) {
	return { x: (cx - viewX) / scale, y: (cy - viewY) / scale };
}

function getPieceGroupId(piece) {
	return piece?.groupId ?? piece?.id ?? null;
}

function getGroupPieces(groupId) {
	return pieces.filter((p) => getPieceGroupId(p) === groupId);
}

function setGroupHeldState(groupId, heldBy, color) {
	getGroupPieces(groupId).forEach((p) => {
		p.heldBy = heldBy;
		p._heldColor = heldBy ? color : null;
	});
}

function moveGroupLocal(groupId, dx, dy) {
	getGroupPieces(groupId).forEach((p) => {
		p.x += dx;
		p.y += dy;
		p._tx = p.x;
		p._ty = p.y;
	});
}

function applyPieceUpdates(updatedPieces) {
	(updatedPieces || []).forEach((upd) => {
		const p = getPiece(upd.id);
		if (!p) return;
		Object.assign(p, upd);
		p._tx = p.x;
		p._ty = p.y;
	});
}

function setGroupTargetByDelta(groupId, dx, dy) {
	getGroupPieces(groupId).forEach((piece) => {
		const tx = typeof piece._tx === "number" ? piece._tx : piece.x;
		const ty = typeof piece._ty === "number" ? piece._ty : piece.y;
		piece._tx = tx + dx;
		piece._ty = ty + dy;
	});
}

function setPieceTargetAbsolute(piece, x, y) {
	piece._tx = x;
	piece._ty = y;
}

function initializePieceTargets() {
	pieces.forEach((piece) => {
		piece._tx = piece.x;
		piece._ty = piece.y;
	});
}

function syncReferencePanel() {
	const panel = document.getElementById("referencePanel");
	const toggle = document.getElementById("referenceToggle");
	const img = document.getElementById("referenceImg");
	if (!panel || !toggle || !img) return;

	panel.classList.toggle("show", referenceVisible);
	toggle.classList.toggle("active", referenceVisible);
	toggle.textContent = referenceVisible ? "Hide Ref" : "Reference";

	if (referenceImageUrl) {
		img.src = referenceImageUrl;
		img.alt = "Reference photo";
	}
}

function toggleReference() {
	referenceVisible = !referenceVisible;
	sessionStorage.setItem("showReference", referenceVisible ? "1" : "0");
	syncReferencePanel();
}

function stepRemoteInterpolation() {
	let moved = false;

	pieces.forEach((piece) => {
		if (piece.heldBy === myId) {
			piece._tx = piece.x;
			piece._ty = piece.y;
			return;
		}

		if (typeof piece._tx !== "number" || typeof piece._ty !== "number") {
			piece._tx = piece.x;
			piece._ty = piece.y;
			return;
		}

		const dx = piece._tx - piece.x;
		const dy = piece._ty - piece.y;

		if (
			Math.abs(dx) <= REMOTE_SNAP_EPSILON &&
			Math.abs(dy) <= REMOTE_SNAP_EPSILON
		) {
			if (dx !== 0 || dy !== 0) {
				piece.x = piece._tx;
				piece.y = piece._ty;
				moved = true;
			}
			return;
		}

		piece.x += dx * REMOTE_LERP;
		piece.y += dy * REMOTE_LERP;
		moved = true;
	});

	if (moved) {
		markDirty();
	}
}

function resizeCanvas() {
	canvas.width = wrap.clientWidth;
	canvas.height = wrap.clientHeight;
	render();
}

// ─── Nickname flow ────────────────────────────────────────────────────────────
function submitNickname() {
	const val = document.getElementById("npInput").value.trim();
	if (!val) return;
	nickname = val;
	sessionStorage.setItem("nickname", nickname);
	document.getElementById("nicknamePrompt").classList.remove("show");
	connectSocket();
}

document.getElementById("npInput").addEventListener("keydown", (e) => {
	if (e.key === "Enter") submitNickname();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
	// Verify room exists
	try {
		const res = await fetch(`/api/room/${roomId}`);
		if (!res.ok) {
			document.getElementById("loading").innerHTML =
				`<div style="text-align:center;padding:2rem;color:#C4522A;font-size:1.1rem">Room not found or expired.<br><br><a href="/" style="color:#D4A84B">← Create a new puzzle</a></div>`;
			return;
		}
	} catch {
		document.getElementById("loading").innerHTML =
			`<div style="text-align:center;padding:2rem;color:#C4522A">Connection error</div>`;
		return;
	}

	if (!nickname) {
		document.getElementById("loading").style.display = "none";
		document.getElementById("nicknamePrompt").classList.add("show");
		document.getElementById("npInput").focus();
		return;
	}

	connectSocket();
}

// ─── Socket ───────────────────────────────────────────────────────────────────
function connectSocket() {
	socket = io();

	socket.on("connect", () => {
		socket.emit("join_room", { roomId, nickname });
	});

	socket.on("error", ({ message }) => {
		document.getElementById("loading").innerHTML =
			`<div style="text-align:center;padding:2rem;color:#C4522A">${message}<br><br><a href="/" style="color:#D4A84B">← Go home</a></div>`;
	});

	socket.on("game_state", (state) => {
		gameState = state;
		myId = state.myId;
		myColor = state.myColor;
		pieces = state.pieces;
		initializePieceTargets();
		players = state.players;
		referenceImageUrl = state.referenceImage || referenceImageUrl;

		document.getElementById("loading").style.display = "none";

		// Update room code label
		document.getElementById("roomCodeLabel").textContent = `⬡ ${roomId}`;
		document.getElementById("shareLink").textContent = window.location.href;

		resizeCanvas();
		window.addEventListener("resize", resizeCanvas);
		setupInteraction();
		loadPieceImages(() => {
			centerBoard();
			syncReferencePanel();
			render();
			startRenderLoop();
		});
		updateUI();

		if (state.complete && state.completedImage) {
			showCompletion({
				completedImage: state.completedImage,
				players,
				duration: null,
			});
		}
	});

	socket.on("player_joined", ({ player }) => {
		players[player.id] = player;
		updateUI();
	});

	socket.on("player_left", ({ playerId }) => {
		delete players[playerId];
		updateUI();
	});

	socket.on("players_update", ({ players: p }) => {
		players = p;
		updateUI();
	});

	socket.on("piece_grabbed", ({ pieceId, groupId, heldBy, color }) => {
		const p = getPiece(pieceId);
		if (!p) return;
		const activeGroupId = groupId || getPieceGroupId(p);
		setGroupHeldState(activeGroupId, heldBy, color);
		markDirty();
	});

	socket.on("piece_moved", ({ pieceId, groupId, dx, dy, x, y }) => {
		const p = getPiece(pieceId);
		if (!p) return;
		const activeGroupId = groupId || getPieceGroupId(p);
		if (typeof dx === "number" && typeof dy === "number") {
			setGroupTargetByDelta(activeGroupId, dx, dy);
		} else if (typeof x === "number" && typeof y === "number") {
			setPieceTargetAbsolute(p, x, y);
		}
		markDirty();
	});

	socket.on(
		"piece_dropped",
		({
			pieceId,
			groupId,
			pieces: updatedPieces,
			locked,
			lockedPieceIds,
			color,
		}) => {
			const p = getPiece(pieceId);
			if (!p) return;

			if (Array.isArray(updatedPieces) && updatedPieces.length > 0) {
				applyPieceUpdates(updatedPieces);
			} else {
				const activeGroupId = groupId || getPieceGroupId(p);
				setGroupHeldState(activeGroupId, null, null);
			}

			if (locked) {
				(lockedPieceIds && lockedPieceIds.length
					? lockedPieceIds
					: [pieceId]
				).forEach((id) => {
					const lp = getPiece(id);
					if (lp) flashPiece(lp, color || myColor);
				});
			}
			updateProgress();
			markDirty();
		},
	);

	socket.on("piece_released", ({ pieceId, groupId }) => {
		const p = getPiece(pieceId);
		if (!p) return;
		const activeGroupId = groupId || getPieceGroupId(p);
		setGroupHeldState(activeGroupId, null, null);
		markDirty();
	});

	socket.on("puzzle_complete", (data) => {
		showCompletion(data);
	});
}

// ─── Load piece images ────────────────────────────────────────────────────────
function loadPieceImages(callback) {
	let loaded = 0;
	const total = pieces.length;
	if (total === 0) {
		callback();
		return;
	}

	pieces.forEach((p) => {
		const img = new Image();
		img.onload = img.onerror = () => {
			loaded++;
			if (loaded === total) callback();
		};
		img.src = `/pieces/${roomId}/${p.id}.jpg`;
		pieceImages[p.id] = img;
	});
}

// ─── Center board ─────────────────────────────────────────────────────────────
function centerBoard() {
	if (!gameState) return;
	const { boardW, boardH } = gameState;
	const cw = canvas.width,
		ch = canvas.height;
	// Scale to fit with padding
	const scaleX = (cw * 0.6) / boardW;
	const scaleY = (ch * 0.8) / boardH;
	scale = Math.min(scaleX, scaleY, 1);
	viewX = (cw - boardW * scale) / 2;
	viewY = (ch - boardH * scale) / 2 + 52 / 2;
}

// ─── Render ───────────────────────────────────────────────────────────────────
let animFrame = null;
let dirty = true;

function startRenderLoop() {
	function loop() {
		stepRemoteInterpolation();
		if (dirty) {
			render();
			dirty = false;
		}
		animFrame = requestAnimationFrame(loop);
	}
	loop();
}

function markDirty() {
	dirty = true;
}

function render() {
	if (!gameState) return;
	const cw = canvas.width,
		ch = canvas.height;
	ctx.clearRect(0, 0, cw, ch);

	// Background grid dots
	drawBackground(cw, ch);

	ctx.save();
	ctx.translate(viewX, viewY);
	ctx.scale(scale, scale);

	// Board outline (target area)
	const { boardW, boardH } = gameState;
	ctx.strokeStyle = "rgba(212,168,75,0.25)";
	ctx.lineWidth = 2 / scale;
	ctx.setLineDash([6 / scale, 4 / scale]);
	ctx.strokeRect(0, 0, boardW, boardH);
	ctx.setLineDash([]);

	// Draw pieces — locked first, then unlocked, then held on top
	const locked = pieces.filter((p) => p.locked);
	const held = pieces.filter((p) => p.heldBy);
	const free = pieces.filter((p) => !p.locked && !p.heldBy);

	locked.forEach(drawPiece);
	free.forEach(drawPiece);
	held.forEach(drawPiece);

	ctx.restore();

	drawMinimap();
}

function drawBackground(cw, ch) {
	const dotSpacing = 30;
	const dotSize = 1.5;
	ctx.fillStyle = "rgba(245,240,232,0.06)";
	const ox = ((viewX % dotSpacing) + dotSpacing) % dotSpacing;
	const oy = ((viewY % dotSpacing) + dotSpacing) % dotSpacing;
	for (let x = ox - dotSpacing; x < cw + dotSpacing; x += dotSpacing) {
		for (let y = oy - dotSpacing; y < ch + dotSpacing; y += dotSpacing) {
			ctx.beginPath();
			ctx.arc(x, y, dotSize, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

function drawPiece(p) {
	const img = pieceImages[p.id];
	const { pieceW, pieceH } = gameState;

	ctx.save();

	// Glow for held pieces
	if (p.heldBy) {
		const color = p._heldColor || myColor;
		ctx.shadowColor = color;
		ctx.shadowBlur = 16 / scale;
		ctx.strokeStyle = color;
		ctx.lineWidth = 3 / scale;
		ctx.strokeRect(p.x, p.y, pieceW, pieceH);
	} else if (p.locked) {
		// Subtle locked indicator
		ctx.shadowColor = "rgba(212,168,75,0.3)";
		ctx.shadowBlur = 4 / scale;
	}

	// Flash animation
	if (p._flashAlpha > 0) {
		ctx.globalAlpha = 1;
		ctx.fillStyle = p._flashColor || "#D4A84B";
		ctx.fillRect(p.x, p.y, pieceW, pieceH);
		ctx.globalAlpha = 1 - p._flashAlpha;
	}

	if (img && img.complete && img.naturalWidth > 0) {
		ctx.drawImage(img, p.x, p.y, pieceW, pieceH);
	} else {
		// Placeholder
		ctx.fillStyle = "#3A342C";
		ctx.fillRect(p.x, p.y, pieceW, pieceH);
		ctx.fillStyle = "rgba(245,240,232,0.2)";
		ctx.font = `${12 / scale}px DM Sans`;
		ctx.textAlign = "center";
		ctx.fillText(p.id, p.x + pieceW / 2, p.y + pieceH / 2);
	}

	// Thin border
	ctx.shadowBlur = 0;
	ctx.globalAlpha = 1;
	ctx.strokeStyle = p.locked ? "rgba(212,168,75,0.4)" : "rgba(26,21,16,0.5)";
	ctx.lineWidth = 1 / scale;
	ctx.strokeRect(p.x, p.y, pieceW, pieceH);

	ctx.restore();
}

// ─── Flash animation ──────────────────────────────────────────────────────────
const flashPieces = new Set();

function flashPiece(p, color) {
	p._flashAlpha = 1;
	p._flashColor = color;
	flashPieces.add(p);
	markDirty();
	const step = () => {
		p._flashAlpha = Math.max(0, p._flashAlpha - 0.06);
		markDirty();
		if (p._flashAlpha > 0) requestAnimationFrame(step);
		else flashPieces.delete(p);
	};
	requestAnimationFrame(step);
}

// ─── Minimap ──────────────────────────────────────────────────────────────────
function drawMinimap() {
	if (!gameState) return;
	const mm = document.getElementById("minimapCanvas");
	const mc = mm.getContext("2d");
	const mw = mm.parentElement.clientWidth;
	const mh = mm.parentElement.clientHeight;
	mm.width = mw;
	mm.height = mh;

	// Scale to fit board in minimap
	const { boardW, boardH } = gameState;
	const ms = Math.min(mw / boardW, mh / boardH) * 0.7;
	const ox = (mw - boardW * ms) / 2;
	const oy = (mh - boardH * ms) / 2;

	mc.clearRect(0, 0, mw, mh);
	mc.fillStyle = "rgba(26,21,16,0.4)";
	mc.fillRect(ox, oy, boardW * ms, boardH * ms);

	pieces.forEach((p) => {
		if (p.locked) {
			mc.fillStyle = "rgba(212,168,75,0.7)";
		} else if (p.heldBy) {
			mc.fillStyle = p._heldColor || "#FF6B6B";
		} else {
			mc.fillStyle = "rgba(245,240,232,0.3)";
		}
		const { pieceW, pieceH } = gameState;
		mc.fillRect(ox + p.x * ms, oy + p.y * ms, pieceW * ms, pieceH * ms);
	});

	// Viewport rect
	const vpW = canvas.width / scale;
	const vpH = canvas.height / scale;
	const vpX = -viewX / scale;
	const vpY = -viewY / scale;
	mc.strokeStyle = "rgba(245,240,232,0.5)";
	mc.lineWidth = 1;
	mc.strokeRect(ox + vpX * ms, oy + vpY * ms, vpW * ms, vpH * ms);
}

// ─── Interaction ──────────────────────────────────────────────────────────────
function setupInteraction() {
	wrap.addEventListener("mousedown", onMouseDown);
	wrap.addEventListener("mousemove", onMouseMove);
	wrap.addEventListener("mouseup", onMouseUp);
	wrap.addEventListener("mouseleave", onMouseUp);
	wrap.addEventListener("wheel", onWheel, { passive: false });

	// Touch
	wrap.addEventListener("touchstart", onTouchStart, { passive: false });
	wrap.addEventListener("touchmove", onTouchMove, { passive: false });
	wrap.addEventListener("touchend", onTouchEnd);
}

function getPieceAt(wx, wy) {
	if (!gameState) return null;
	const { pieceW, pieceH } = gameState;
	// Match render layering: locked (bottom), free (middle), held (top)
	const drawOrder = [
		...pieces.filter((p) => p.locked),
		...pieces.filter((p) => !p.locked && !p.heldBy),
		...pieces.filter((p) => p.heldBy),
	];

	for (let i = drawOrder.length - 1; i >= 0; i--) {
		const p = drawOrder[i];
		if (wx >= p.x && wx <= p.x + pieceW && wy >= p.y && wy <= p.y + pieceH) {
			return p;
		}
	}
	return null;
}

function onMouseDown(e) {
	if (e.button !== 0) return;
	const rect = canvas.getBoundingClientRect();
	const cx = e.clientX - rect.left;
	const cy = e.clientY - rect.top;
	const { x: wx, y: wy } = canvasToWorld(cx, cy);

	const p = getPieceAt(wx, wy);

	if (p && !p.locked && !p.heldBy) {
		heldPieceId = p.id;
		heldGroupId = getPieceGroupId(p);
		dragOffsetX = wx - p.x;
		dragOffsetY = wy - p.y;
		setGroupHeldState(heldGroupId, myId, myColor);
		socket.emit("piece_grab", { pieceId: p.id });
		wrap.classList.add("piece-held");
		markDirty();
	} else if (!p) {
		isPanning = true;
		panStartX = e.clientX;
		panStartY = e.clientY;
		panViewX = viewX;
		panViewY = viewY;
		wrap.classList.add("grabbing");
	}

	lastMouseX = e.clientX;
	lastMouseY = e.clientY;
}

function onMouseMove(e) {
	const rect = canvas.getBoundingClientRect();
	const cx = e.clientX - rect.left;
	const cy = e.clientY - rect.top;

	if (heldPieceId !== null) {
		const { x: wx, y: wy } = canvasToWorld(cx, cy);
		const p = getPiece(heldPieceId);
		if (p) {
			const nx = wx - dragOffsetX;
			const ny = wy - dragOffsetY;
			const dx = nx - p.x;
			const dy = ny - p.y;
			if (heldGroupId !== null && (dx !== 0 || dy !== 0)) {
				moveGroupLocal(heldGroupId, dx, dy);
			} else {
				p.x = nx;
				p.y = ny;
			}
			socket.volatile.emit("piece_move", { pieceId: p.id, x: nx, y: ny });
			markDirty();
		}
	} else if (isPanning) {
		viewX = panViewX + (e.clientX - panStartX);
		viewY = panViewY + (e.clientY - panStartY);
		markDirty();
	}
}

function onMouseUp(e) {
	if (heldPieceId !== null) {
		const p = getPiece(heldPieceId);
		if (p) {
			setGroupHeldState(heldGroupId, null, null);
			socket.emit("piece_drop", { pieceId: p.id, x: p.x, y: p.y });
		}
		heldPieceId = null;
		heldGroupId = null;
		wrap.classList.remove("piece-held");
		markDirty();
	}

	if (isPanning) {
		isPanning = false;
		wrap.classList.remove("grabbing");
	}
}

function onWheel(e) {
	e.preventDefault();
	const rect = canvas.getBoundingClientRect();
	const cx = e.clientX - rect.left;
	const cy = e.clientY - rect.top;

	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
	const ratio = newScale / scale;

	viewX = cx - (cx - viewX) * ratio;
	viewY = cy - (cy - viewY) * ratio;
	scale = newScale;
	markDirty();
}

// Touch
let lastTouchDist = null;
let touchPieceId = null;

function onTouchStart(e) {
	e.preventDefault();
	if (e.touches.length === 1) {
		const t = e.touches[0];
		const rect = canvas.getBoundingClientRect();
		const cx = t.clientX - rect.left;
		const cy = t.clientY - rect.top;
		const { x: wx, y: wy } = canvasToWorld(cx, cy);

		const p = getPieceAt(wx, wy);
		if (p && !p.locked && !p.heldBy) {
			touchPieceId = p.id;
			heldPieceId = p.id;
			heldGroupId = getPieceGroupId(p);
			dragOffsetX = wx - p.x;
			dragOffsetY = wy - p.y;
			setGroupHeldState(heldGroupId, myId, myColor);
			socket.emit("piece_grab", { pieceId: p.id });
		} else {
			isPanning = true;
			panStartX = t.clientX;
			panStartY = t.clientY;
			panViewX = viewX;
			panViewY = viewY;
		}
	} else if (e.touches.length === 2) {
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		lastTouchDist = Math.sqrt(dx * dx + dy * dy);
	}
}

function onTouchMove(e) {
	e.preventDefault();
	if (e.touches.length === 1) {
		const t = e.touches[0];
		const rect = canvas.getBoundingClientRect();
		const cx = t.clientX - rect.left;
		const cy = t.clientY - rect.top;

		if (heldPieceId !== null) {
			const { x: wx, y: wy } = canvasToWorld(cx, cy);
			const p = getPiece(heldPieceId);
			if (p) {
				const nx = wx - dragOffsetX;
				const ny = wy - dragOffsetY;
				const dx = nx - p.x;
				const dy = ny - p.y;
				if (heldGroupId !== null && (dx !== 0 || dy !== 0)) {
					moveGroupLocal(heldGroupId, dx, dy);
				} else {
					p.x = nx;
					p.y = ny;
				}
				socket.volatile.emit("piece_move", { pieceId: p.id, x: nx, y: ny });
				markDirty();
			}
		} else if (isPanning) {
			viewX = panViewX + (t.clientX - panStartX);
			viewY = panViewY + (t.clientY - panStartY);
			markDirty();
		}
	} else if (e.touches.length === 2 && lastTouchDist) {
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const mid = {
			x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
			y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
		};
		const rect = canvas.getBoundingClientRect();
		const cx = mid.x - rect.left;
		const cy = mid.y - rect.top;

		const newScale = Math.min(
			MAX_SCALE,
			Math.max(MIN_SCALE, scale * (dist / lastTouchDist)),
		);
		const ratio = newScale / scale;
		viewX = cx - (cx - viewX) * ratio;
		viewY = cy - (cy - viewY) * ratio;
		scale = newScale;
		lastTouchDist = dist;
		markDirty();
	}
}

function onTouchEnd(e) {
	if (heldPieceId !== null) {
		const p = getPiece(heldPieceId);
		if (p) {
			setGroupHeldState(heldGroupId, null, null);
			socket.emit("piece_drop", { pieceId: p.id, x: p.x, y: p.y });
		}
		heldPieceId = null;
		heldGroupId = null;
		touchPieceId = null;
		markDirty();
	}
	isPanning = false;
	lastTouchDist = null;
}

// ─── Zoom controls ────────────────────────────────────────────────────────────
function adjustZoom(delta) {
	const cx = canvas.width / 2,
		cy = canvas.height / 2;
	const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
	const ratio = newScale / scale;
	viewX = cx - (cx - viewX) * ratio;
	viewY = cy - (cy - viewY) * ratio;
	scale = newScale;
	markDirty();
}

function resetZoom() {
	centerBoard();
	markDirty();
}

// ─── UI updates ───────────────────────────────────────────────────────────────
function updateUI() {
	updateProgress();
	updatePlayers();
}

function updateProgress() {
	if (!gameState) return;
	const total = pieces.length;
	const locked = pieces.filter((p) => p.locked).length;
	const pct = total > 0 ? (locked / total) * 100 : 0;
	document.getElementById("progressFill").style.width = `${pct}%`;
	document.getElementById("progressLabel").textContent = `${locked} / ${total}`;
}

function updatePlayers() {
	const list = document.getElementById("playersList");
	list.innerHTML = "";
	Object.values(players)
		.slice(0, 8)
		.forEach((p) => {
			const pip = document.createElement("div");
			pip.className = "player-pip";
			pip.style.background = p.color;
			pip.title = `${p.nickname} — ${p.score} pieces`;
			pip.textContent = p.nickname.substring(0, 2);
			const badge = document.createElement("div");
			badge.className = "score-badge";
			badge.textContent = p.score || 0;
			pip.appendChild(badge);
			list.appendChild(pip);
		});
}

// ─── Share ────────────────────────────────────────────────────────────────────
let shareVisible = false;

function toggleShare() {
	shareVisible = !shareVisible;
	document.getElementById("shareToast").classList.toggle("show", shareVisible);
}

function copyLink() {
	navigator.clipboard.writeText(window.location.href).then(() => {
		const m = document.getElementById("copiedMsg");
		m.style.display = "block";
		setTimeout(() => {
			m.style.display = "none";
		}, 2000);
	});
}

// ─── Completion ───────────────────────────────────────────────────────────────
function showCompletion({ completedImage, players: p, duration }) {
	const overlay = document.getElementById("completionOverlay");
	overlay.classList.add("show");

	if (completedImage) {
		const img = document.getElementById("completeImg");
		img.src = completedImage;
		document.getElementById("downloadBtn").href = completedImage;
	}

	const stats = document.getElementById("completeStats");
	const sorted = Object.values(p || players).sort((a, b) => b.score - a.score);

	let html = "";
	sorted.forEach((pl, i) => {
		html += `<div class="stat">
      <div class="stat-val" style="color:${pl.color}">${pl.score}</div>
      <div class="stat-label">${i === 0 ? "🏆 " : ""}${pl.nickname}</div>
    </div>`;
	});

	if (duration) {
		const mins = Math.floor(duration / 60);
		const secs = duration % 60;
		html += `<div class="stat">
      <div class="stat-val">${mins}:${String(secs).padStart(2, "0")}</div>
      <div class="stat-label">Time</div>
    </div>`;
	}

	stats.innerHTML = html;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function getPiece(id) {
	return pieces.find((p) => p.id === id) || null;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
