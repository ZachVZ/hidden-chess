// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
// Include chess.js for move validation and internal game state.
const Chess = require('chess.js').Chess;

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const port = process.env.PORT || 3000;

app.use(express.static('public'));

let waitingPlayer = null;
let games = {};

// Create a randomized back rank using Chess960–style rules.
function createChess960BackRank() {
  let squares = Array(8).fill(null);
  // Place bishops on opposite-colored squares.
  let darkSquares = [1, 3, 5, 7];
  let lightSquares = [0, 2, 4, 6];
  let bishopPos1 = darkSquares[Math.floor(Math.random() * darkSquares.length)];
  let bishopPos2 = lightSquares[Math.floor(Math.random() * lightSquares.length)];
  squares[bishopPos1] = 'B';
  squares[bishopPos2] = 'B';

  // Place the queen in one of the remaining squares.
  let emptyIndices = squares.map((v, i) => (v === null ? i : null)).filter(x => x !== null);
  let queenPos = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  squares[queenPos] = 'Q';

  // Place two knights in two of the remaining squares.
  emptyIndices = squares.map((v, i) => (v === null ? i : null)).filter(x => x !== null);
  let knightPos1 = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  squares[knightPos1] = 'N';
  emptyIndices = squares.map((v, i) => (v === null ? i : null)).filter(x => x !== null);
  let knightPos2 = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  squares[knightPos2] = 'N';

  // The remaining three squares: place two rooks and a king (king must be between the rooks).
  emptyIndices = squares.map((v, i) => (v === null ? i : null)).filter(x => x !== null);
  emptyIndices.sort((a, b) => a - b);
  squares[emptyIndices[0]] = 'R';
  squares[emptyIndices[1]] = 'K';
  squares[emptyIndices[2]] = 'R';

  return squares;
}

// Set up a player’s pieces.
// For the back rank, we use our randomized setup;
// For pawns, we use standard positions.
function setupPlayerPieces(color) {
  let pieces = {};
  const files = 'abcdefgh';
  let backRank = createChess960BackRank();
  let rank = (color === 'white') ? '1' : '8';
  for (let i = 0; i < 8; i++) {
    pieces[files[i] + rank] = backRank[i];
  }
  let pawnRank = (color === 'white') ? '2' : '7';
  for (let i = 0; i < 8; i++) {
    pieces[files[i] + pawnRank] = 'P';
  }
  return pieces;
}

// Helper: Compress a rank string for FEN notation (replace consecutive "1"s with a number)
function compressFenRank(rankStr) {
  return rankStr.replace(/1+/g, match => match.length);
}

// Generate an initial FEN string based on the two players’ piece placements.
// Note: For black pieces, letters are converted to lowercase.
function generateInitialFEN(whitePieces, blackPieces) {
  const files = 'abcdefgh';
  let fenRanks = [];

  // Rank 8: Black back rank.
  let rankStr = '';
  for (let i = 0; i < 8; i++) {
    let square = files[i] + '8';
    let piece = blackPieces[square];
    rankStr += piece ? piece.toLowerCase() : '1';
  }
  fenRanks.push(compressFenRank(rankStr));

  // Rank 7: Black pawns.
  rankStr = '';
  for (let i = 0; i < 8; i++) {
    let square = files[i] + '7';
    let piece = blackPieces[square];
    // In setupPlayerPieces, pawns are marked as 'P' so convert to lowercase.
    rankStr += piece ? piece.toLowerCase() : '1';
  }
  fenRanks.push(compressFenRank(rankStr));

  // Ranks 6 to 3: empty.
  fenRanks.push("8");
  fenRanks.push("8");
  fenRanks.push("8");
  fenRanks.push("8");

  // Rank 2: White pawns.
  rankStr = '';
  for (let i = 0; i < 8; i++) {
    let square = files[i] + '2';
    let piece = whitePieces[square];
    rankStr += piece ? piece : '1';
  }
  fenRanks.push(compressFenRank(rankStr));

  // Rank 1: White back rank.
  rankStr = '';
  for (let i = 0; i < 8; i++) {
    let square = files[i] + '1';
    let piece = whitePieces[square];
    rankStr += piece ? piece : '1';
  }
  fenRanks.push(compressFenRank(rankStr));

  // Assemble the full FEN.
  let boardFen = fenRanks.join('/');
  let activeColor = "w"; // white starts
  let castling = "-";
  let enPassant = "-";
  let halfmove = "0";
  let fullmove = "1";
  return `${boardFen} ${activeColor} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
}

io.on('connection', socket => {
  console.log('New connection:', socket.id);
  
  socket.on('joinGame', () => {
    if (waitingPlayer) {
      // Pair with waiting player.
      let gameId = waitingPlayer.id + '#' + socket.id;
      // Initialize game state.
      let whitePieces = setupPlayerPieces('white');
      let blackPieces = setupPlayerPieces('black');
      let initialFEN = generateInitialFEN(whitePieces, blackPieces);
      let game = {
        id: gameId,
        players: {
          white: waitingPlayer.id,
          black: socket.id
        },
        // Store each side’s pieces by board square.
        pieces: {
          white: whitePieces,
          black: blackPieces
        },
        // 'revealed' tracks which opponent pieces have been uncovered.
        revealed: {
          white: {},
          black: {}
        },
        turn: 'white',
        // Initialize a chess.js instance with the initial position.
        chess: new Chess(initialFEN)
      };
      games[gameId] = game;
      waitingPlayer.emit('gameStart', { game, color: 'white' });
      socket.emit('gameStart', { game, color: 'black' });
      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waiting', {});
    }
  });
  
  socket.on('makeMove', data => {
    // data: { gameId, from, to, color }
    let game = games[data.gameId];
    if (!game) return;
    if (game.turn !== data.color) return;
    
    // Use chess.js to validate the move.
    let moveResult = game.chess.move({ from: data.from, to: data.to, promotion: 'q' });
    if (!moveResult) return;  // Illegal move
    
    // Custom logic to update hidden information.
    let playerPieces = game.pieces[data.color];
    if (!playerPieces[data.from]) return; // sanity check
    let movingPiece = playerPieces[data.from];
    let opponentColor = data.color === 'white' ? 'black' : 'white';
    let opponentPieces = game.pieces[opponentColor];
    let capture = false;
    if (opponentPieces[data.to]) {
      capture = true;
      // Reveal the captured piece to both players.
      game.revealed[opponentColor][data.to] = opponentPieces[data.to];
      delete opponentPieces[data.to];
    }
    
    // Move the piece.
    playerPieces[data.to] = movingPiece;
    delete playerPieces[data.from];
    
    // If a capture occurred, also reveal the moving piece.
    if (capture) {
      game.revealed[data.color][data.to] = movingPiece;
    }
    
    // Switch turn.
    game.turn = opponentColor;
    
    // Broadcast the updated game state.
    io.to(game.players.white).emit('updateGame', game);
    io.to(game.players.black).emit('updateGame', game);
  });
  
  socket.on('disconnect', () => {
    console.log('Disconnect:', socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    // (Additional cleanup for active games would be needed in a full implementation.)
  });
});

server.listen(port, () => {
  console.log('Server running on port', port);
});
