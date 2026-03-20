const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' })); // Cho phép gửi dữ liệu đề thi có chứa ảnh lớn
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const BASE_URL = 'https://appthitructiep-default-rtdb.asia-southeast1.firebasedatabase.app';

const rooms = {}; 

const defaultQuizData = [
    {
        type: 'multiple_choice',
        question: "Trong JavaScript, từ khóa nào dùng để khai báo biến có thể thay đổi giá trị?",
        answers: ["A. const", "B. let", "C. static", "D. final"],
        correctIndex: 1 
    },
    {
        type: 'multiple_choice',
        question: "Đâu là một framework của JavaScript?",
        answers: ["A. Django", "B. Laravel", "C. React", "D. Spring Boot"],
        correctIndex: 2
    }
];

// API Đăng ký và Đăng nhập
app.post('/api/auth', async (req, res) => {
    try {
        const { username, password, action } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin!" });
        
        const safeUser = encodeURIComponent(username).replace(/[\.\$\[\]\#\/]/g, '_');
        const userUrl = `${BASE_URL}/users/${safeUser}.json`;
        
        const response = await axios.get(userUrl);
        const userData = response.data;

        if (action === 'register') {
            if (userData) return res.status(400).json({ error: "Tên đăng nhập đã có người sử dụng!" });
            await axios.put(userUrl, { password: password }); 
            return res.json({ success: true, username: safeUser });
        } else if (action === 'login') {
            if (!userData || userData.password !== password) return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu!" });
            return res.json({ success: true, username: safeUser });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lấy kho đề theo tài khoản
app.get('/api/quizzes', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(401).json({ error: "Chưa đăng nhập!" });
        
        const response = await axios.get(`${BASE_URL}/quizzes/${username}.json`);
        const data = response.data;
        const quizzes = [];
        if (data) { for (let key in data) { quizzes.push(data[key]); } }
        res.json(quizzes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lưu/Cập nhật đề vào đúng tài khoản
app.post('/api/quizzes', async (req, res) => {
    try {
        const { name, data, timeSetting, username } = req.body;
        if (!username) return res.status(401).json({ error: "Chưa đăng nhập!" });
        
        const safeName = encodeURIComponent(name).replace(/[\.\$\[\]\#\/]/g, '_');
        await axios.put(`${BASE_URL}/quizzes/${username}/${safeName}.json`, { name, data, timeSetting });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Xóa đề của đúng tài khoản
app.delete('/api/quizzes/:name', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(401).json({ error: "Chưa đăng nhập!" });
        
        const safeName = encodeURIComponent(req.params.name).replace(/[\.\$\[\]\#\/]/g, '_');
        await axios.delete(`${BASE_URL}/quizzes/${username}/${safeName}.json`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

function startTimer(pin) {
    if (rooms[pin].timer) clearInterval(rooms[pin].timer); 
    
    rooms[pin].timeLeft = rooms[pin].timeSetting || 20; 
    io.to(pin).emit('timerTick', rooms[pin].timeLeft);

    rooms[pin].timer = setInterval(() => {
        rooms[pin].timeLeft--;
        io.to(pin).emit('timerTick', rooms[pin].timeLeft);

        if (rooms[pin].timeLeft <= 0) {
            clearInterval(rooms[pin].timer); 
            io.to(pin).emit('timeUp'); 
            
            // Gán "Hết giờ" cho học sinh chưa trả lời
            const currentQuestionIndex = rooms[pin].currentQuestionIndex;
            for (const sid in rooms[pin].playerNames) {
                if (!rooms[pin].studentHistory[sid]) rooms[pin].studentHistory[sid] = [];
                if (rooms[pin].studentHistory[sid][currentQuestionIndex] === undefined) {
                    rooms[pin].studentHistory[sid][currentQuestionIndex] = "Không trả lời (Hết giờ)";
                }
            }

            io.to(rooms[pin].hostId).emit('updateStats', {
                answerCounts: rooms[pin].answerCounts,
                answeredCount: rooms[pin].answeredCount,
                totalPlayers: rooms[pin].players.length,
                forceShowNext: true 
            });
            console.log(`⏰ Hết giờ tại phòng ${pin}`);
        }
    }, 1000);
}

require('./auctionHandler')(io);

io.on('connection', (socket) => {
    console.log('⚡ Một thiết bị vừa kết nối:', socket.id);

    socket.on('startGame', (pin) => {
        if (rooms[pin] && rooms[pin].hostId === socket.id) {
            rooms[pin].currentQuestionIndex = 0; 
            rooms[pin].answerCounts = [0, 0, 0, 0]; 
            rooms[pin].answeredCount = 0; 

            const firstQuestion = rooms[pin].quizData[0];
            socket.emit('showQuestion', firstQuestion);
            
            let payload = { type: firstQuestion.type || 'multiple_choice' };
            if (firstQuestion.type === 'drag_drop') {
                payload.shuffledAnswers = [...firstQuestion.answers].sort(() => Math.random() - 0.5);
            } else if (firstQuestion.type === 'image_match') {
                payload.images = firstQuestion.images || [];
            } else if (firstQuestion.type === 'drag_classify') {
                let allWords = [];
                (firstQuestion.categories || []).forEach(cat => {
                    allWords = allWords.concat(cat.items || []);
                });
                payload.categories = (firstQuestion.categories || []).map(c => c.name);
                payload.wordBank = allWords.sort(() => Math.random() - 0.5);
            } else if (firstQuestion.type === 'drag_text') {
                payload.textParts = firstQuestion.textParts || [];
                payload.wordBank = [...(firstQuestion.correctAnswers || [])].sort(() => Math.random() - 0.5);
            } else if (firstQuestion.type === 'drag_image') {
                let allAnswers = (firstQuestion.dropZones || []).map(z => z.answer);
                payload.mainImage = firstQuestion.mainImage;
                payload.dropZones = (firstQuestion.dropZones || []).map(z => ({ x: z.x, y: z.y }));
                payload.wordBank = allAnswers.sort(() => Math.random() - 0.5);
            }
            socket.to(pin).emit('showAnswerButtons', payload);
            
            startTimer(pin);
            
            console.log(`▶️ Trò chơi bắt đầu tại phòng ${pin}`);
        }
    });

    socket.on('createRoom', () => {
        const pin = Math.floor(100000 + Math.random() * 900000).toString(); 
        rooms[pin] = { 
            hostId: socket.id, 
            players: [],       
            scores: {},
            playerNames: {},
            studentHistory: {},
            timeLeft: 0, 
            timer: null,
            quizData: defaultQuizData, 
            timeSetting: 20
        };
        socket.join(pin); 
        socket.emit('roomCreated', pin); 
        console.log(`🏫 Phòng mới tạo (Đề mặc định): ${pin}`);
    });

    socket.on('createRoomWithData', (data) => {
        const pin = Math.floor(100000 + Math.random() * 900000).toString(); 
        rooms[pin] = { 
            hostId: socket.id, 
            players: [],       
            scores: {},
            playerNames: {},
            studentHistory: {},
            timeLeft: 0, 
            timer: null,
            quizData: data.quizData,       
            timeSetting: data.timeSetting  
        };
        socket.join(pin); 
        socket.emit('roomCreated', pin); 
        console.log(`🏫 Phòng mới tạo (Đề tự soạn - ${data.quizData.length} câu - ${data.timeSetting}s): ${pin}`);
    });

    socket.on('joinRoom', (data) => {
        const pin = data.pin;
        const name = data.name;

        if (rooms[pin]) {
            socket.join(pin);
            rooms[pin].players.push(name);
            rooms[pin].scores[socket.id] = 0;
            rooms[pin].playerNames[socket.id] = name;
            rooms[pin].studentHistory[socket.id] = [];

            socket.emit('joinSuccess');
            io.to(rooms[pin].hostId).emit('playerJoined', name);
            console.log(`👨‍🎓 ${name} đã tham gia phòng ${pin}`);
        } else {
            socket.emit('joinError', 'Mã phòng không tồn tại hoặc đã đóng!');
        }
    });

    socket.on('submitAnswer', (data) => {
        const pin = data.pin;
        const answerIndex = data.answerIndex; 
        const answerText = data.answerText;   
        const answerArray = data.answerArray; 
        const answerObj = data.answerObj; 

        if (rooms[pin] && rooms[pin].scores !== undefined && rooms[pin].timeLeft > 0) {
            const currentQIndex = rooms[pin].currentQuestionIndex;
            const currentQ = rooms[pin].quizData[currentQIndex];

            let historyAnswerStr = "Đã chọn đáp án";
            if (currentQ.type === 'fill_blank') historyAnswerStr = answerText || "Để trống";
            else if (currentQ.type === 'drag_drop' || currentQ.type === 'drag_text' || currentQ.type === 'drag_image' || currentQ.type === 'image_match') historyAnswerStr = (answerArray || []).join(' | ');
            else if (currentQ.type === 'drag_classify') historyAnswerStr = "Đã phân loại nhóm";
            else historyAnswerStr = currentQ.answers[answerIndex] || "Không rõ";

            // Lưu vết
            if(!rooms[pin].studentHistory[socket.id]) rooms[pin].studentHistory[socket.id] = [];
            rooms[pin].studentHistory[socket.id][currentQIndex] = historyAnswerStr;

            let isCorrect = false;

            if (currentQ.type === 'fill_blank') {
                const studentAns = (answerText || "").toString().trim().toLowerCase();
                const correctAns = (currentQ.correctText || "").toString().trim().toLowerCase();
                
                if (studentAns === correctAns && studentAns !== "") {
                    isCorrect = true;
                }
            } else if (currentQ.type === 'drag_drop') { 
                const studentAns = JSON.stringify(answerArray || []);
                const correctAns = JSON.stringify(currentQ.answers || []);
                
                if (studentAns === correctAns && answerArray && answerArray.length > 0) {
                    isCorrect = true;
                }
            } else if (currentQ.type === 'image_match') {
                const studentAnsArray = (answerArray || []).map(str => (str || "").toString().trim().toLowerCase());
                const correctAnsArray = (currentQ.correctAnswers || []).map(str => (str || "").toString().trim().toLowerCase());
                
                if (studentAnsArray.length > 0 && studentAnsArray.length === correctAnsArray.length) {
                    let allMatch = true;
                    for(let i = 0; i < studentAnsArray.length; i++) {
                        if(studentAnsArray[i] !== correctAnsArray[i]) {
                            allMatch = false;
                            break;
                        }
                    }
                    if (allMatch) {
                        isCorrect = true;
                    }
                }
            } else if (currentQ.type === 'drag_classify') {
                const studentAnsObj = answerObj || {};
                let isAllCorrect = true;
                let totalCorrectItems = 0;
                let totalStudentItems = 0;
                
                for (let cat of (currentQ.categories || [])) {
                    let catName = cat.name;
                    let correctItems = (cat.items || []).map(i => i.toString().toLowerCase().trim()).sort();
                    let studentItems = (studentAnsObj[catName] || []).map(i => i.toString().toLowerCase().trim()).sort();
                    
                    totalCorrectItems += correctItems.length;
                    totalStudentItems += studentItems.length;

                    if (JSON.stringify(correctItems) !== JSON.stringify(studentItems)) {
                        isAllCorrect = false;
                        break;
                    }
                }
                
                if (isAllCorrect && totalCorrectItems > 0 && totalCorrectItems === totalStudentItems) {
                    isCorrect = true;
                }
            } else if (currentQ.type === 'drag_text') {
                const studentAnsArray = (answerArray || []).map(str => (str || "").toString().trim().toLowerCase());
                const correctAnsArray = (currentQ.correctAnswers || []).map(str => (str || "").toString().trim().toLowerCase());
                
                if (studentAnsArray.length > 0 && studentAnsArray.length === correctAnsArray.length) {
                    let allMatch = true;
                    for(let i = 0; i < studentAnsArray.length; i++) {
                        if(studentAnsArray[i] !== correctAnsArray[i]) {
                            allMatch = false;
                            break;
                        }
                    }
                    if (allMatch) {
                        isCorrect = true;
                    }
                }
            } else if (currentQ.type === 'drag_image') {
                // THÊM MỚI: Chấm điểm Kéo thả vào Ảnh (Kiểm tra xem các từ học sinh điền có khớp với vị trí tọa độ gốc không)
                const studentAnsArray = (answerArray || []).map(str => (str || "").toString().trim().toLowerCase());
                const correctAnsArray = (currentQ.dropZones || []).map(z => (z.answer || "").toString().trim().toLowerCase());
                
                if (studentAnsArray.length > 0 && studentAnsArray.length === correctAnsArray.length) {
                    let allMatch = true;
                    for(let i = 0; i < studentAnsArray.length; i++) {
                        if(studentAnsArray[i] !== correctAnsArray[i]) {
                            allMatch = false;
                            break;
                        }
                    }
                    if (allMatch) {
                        isCorrect = true;
                    }
                }
            } else {
                if (answerIndex === currentQ.correctIndex) {
                    isCorrect = true;
                }
            }

            if (isCorrect) {
                const timeBonus = rooms[pin].timeLeft * 10; 
                rooms[pin].scores[socket.id] += (1000 + timeBonus);
            }

            if(!rooms[pin].answerCounts) rooms[pin].answerCounts = [0,0,0,0];
            if(!rooms[pin].answeredCount) rooms[pin].answeredCount = 0;

            // Bỏ qua biểu đồ A B C D nếu không phải trắc nghiệm
            if (currentQ.type !== 'fill_blank' && currentQ.type !== 'drag_drop' && currentQ.type !== 'image_match' && currentQ.type !== 'drag_classify' && currentQ.type !== 'drag_text' && currentQ.type !== 'drag_image') {
                rooms[pin].answerCounts[answerIndex]++;
            }
            
            rooms[pin].answeredCount++;

            socket.emit('answerResult', {
                isCorrect: isCorrect,
                score: rooms[pin].scores[socket.id]
            });

            io.to(rooms[pin].hostId).emit('updateStats', {
                answerCounts: rooms[pin].answerCounts,
                answeredCount: rooms[pin].answeredCount,
                totalPlayers: rooms[pin].players.length,
                forceShowNext: false
            });
            
            if (rooms[pin].answeredCount === rooms[pin].players.length) {
                clearInterval(rooms[pin].timer);
            }

            console.log(`📝 ${rooms[pin].playerNames[socket.id]} trả lời ${isCorrect ? 'ĐÚNG' : 'SAI'}`);
        }
    });

    socket.on('nextQuestion', (pin) => {
        if (rooms[pin] && rooms[pin].hostId === socket.id) {
            rooms[pin].currentQuestionIndex++; 
            
            if (rooms[pin].currentQuestionIndex < rooms[pin].quizData.length) {
                rooms[pin].answerCounts = [0, 0, 0, 0];
                rooms[pin].answeredCount = 0;

                const nextQ = rooms[pin].quizData[rooms[pin].currentQuestionIndex];
                
                socket.emit('showQuestion', nextQ);
                
                let payload = { type: nextQ.type || 'multiple_choice' };
                if (nextQ.type === 'drag_drop') {
                    payload.shuffledAnswers = [...nextQ.answers].sort(() => Math.random() - 0.5);
                } else if (nextQ.type === 'image_match') {
                    payload.images = nextQ.images || [];
                } else if (nextQ.type === 'drag_classify') {
                    let allWords = [];
                    (nextQ.categories || []).forEach(cat => { allWords = allWords.concat(cat.items || []); });
                    payload.categories = (nextQ.categories || []).map(c => c.name);
                    payload.wordBank = allWords.sort(() => Math.random() - 0.5);
                } else if (nextQ.type === 'drag_text') {
                    payload.textParts = nextQ.textParts || [];
                    payload.wordBank = [...(nextQ.correctAnswers || [])].sort(() => Math.random() - 0.5);
                } else if (nextQ.type === 'drag_image') {
                    let allAnswers = (nextQ.dropZones || []).map(z => z.answer);
                    payload.mainImage = nextQ.mainImage;
                    payload.dropZones = (nextQ.dropZones || []).map(z => ({ x: z.x, y: z.y }));
                    payload.wordBank = allAnswers.sort(() => Math.random() - 0.5);
                }
                socket.to(pin).emit('showAnswerButtons', payload);
                
                startTimer(pin);
                
                console.log(`⏭️ Chuyển sang câu hỏi ${rooms[pin].currentQuestionIndex + 1} tại phòng ${pin}`);
            } else {
                if (rooms[pin].timer) clearInterval(rooms[pin].timer); 

                const leaderboard = [];
                for (const socketId in rooms[pin].scores) {
                    leaderboard.push({
                        name: rooms[pin].playerNames[socketId] || "Ẩn danh",
                        score: rooms[pin].scores[socketId]
                    });
                }
                leaderboard.sort((a, b) => b.score - a.score);

                socket.emit('endGame', {
                    leaderboard: leaderboard,
                    history: rooms[pin].studentHistory,
                    quizData: rooms[pin].quizData,
                    playerNames: rooms[pin].playerNames
                });
                socket.to(pin).emit('endGameStudent', { leaderboard: leaderboard, history: rooms[pin].studentHistory, quizData: rooms[pin].quizData });
                console.log(`🛑 Đã kết thúc game tại phòng ${pin}`);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Một thiết bị đã thoát:', socket.id);
    });
});

const PORT = process.env.PORT || 8001;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});