const auctionRooms = {};

module.exports = function(io) {
    io.on('connection', (socket) => {

        // 1. Tạo phòng Đấu giá
        socket.on('auc_createRoom', () => {
            const pin = Math.floor(100000 + Math.random() * 900000).toString();
            auctionRooms[pin] = {
                hostId: socket.id,
                players: {},
                currentAuction: null,
                auctionType: null // 'truth' hoặc 'question'
            };
            socket.join(pin);
            socket.emit('auc_roomCreated', pin);
        });

        // 2. Học sinh vào phòng
        socket.on('auc_joinRoom', ({ pin, name }) => {
            if (auctionRooms[pin]) {
                socket.join(pin);
                auctionRooms[pin].players[socket.id] = { name: name, balance: 2000 }; 
                socket.emit('auc_joinSuccess', { name, balance: 2000 });
                io.to(auctionRooms[pin].hostId).emit('auc_updatePlayers', auctionRooms[pin].players);
            } else {
                socket.emit('auc_error', 'Mã phòng không tồn tại!');
            }
        });

        // ==========================================
        // 🔹 CHẾ ĐỘ 1: ĐẤU GIÁ SỰ THẬT (NHẬP TAY)
        // ==========================================
        socket.on('auc_startItem', ({ pin, statement, isTrue, trueReward }) => {
            const room = auctionRooms[pin];
            if (room && room.hostId === socket.id) {
                room.auctionType = 'truth';
                room.currentAuction = { statement, isTrue, trueReward, highestBid: 0, highestBidderId: null, highestBidderName: null };
                io.to(pin).emit('auc_itemStarted', { statement });
            }
        });

        socket.on('auc_endItem', (pin) => {
            const room = auctionRooms[pin];
            if (room && room.auctionType === 'truth' && room.hostId === socket.id) {
                const auc = room.currentAuction;
                let resultMsg = "";
                if (auc.highestBidderId) {
                    const winner = room.players[auc.highestBidderId];
                    winner.balance -= auc.highestBid; 
                    if (auc.isTrue) {
                        winner.balance += auc.trueReward; 
                        resultMsg = `✅ SỰ THẬT! Nhóm [${winner.name}] mua giá ${auc.highestBid}$ và thu về ${auc.trueReward}$!`;
                    } else {
                        resultMsg = `❌ CÚ LỪA! Nhóm [${winner.name}] đã mua hớ và mất trắng ${auc.highestBid}$!`;
                    }
                } else { resultMsg = "⏳ Không có nhóm nào tham gia đấu giá!"; }
                room.currentAuction = null;
                io.to(pin).emit('auc_itemEnded', { resultMsg, players: room.players });
                io.to(room.hostId).emit('auc_updatePlayers', room.players);
            }
        });

        // ==========================================
        // 🔹 CHẾ ĐỘ 2: ĐẤU GIÁ QUYỀN TRẢ LỜI (KHO ĐỀ)
        // ==========================================
        socket.on('auc_startQuestion', ({ pin, questionData, reward }) => {
            const room = auctionRooms[pin];
            if (room && room.hostId === socket.id) {
                room.auctionType = 'question';
                room.currentAuction = {
                    questionData: questionData,
                    reward: reward,
                    highestBid: 0,
                    highestBidderId: null,
                    highestBidderName: null,
                    status: 'bidding' // Đang đấu giá
                };
                // Báo cho học sinh biết câu hỏi đang đấu giá (Chưa gửi đáp án để giấu thông tin)
                io.to(pin).emit('auc_questionBiddingStarted', { questionData: questionData });
            }
        });

        // Chốt giá và giao quyền trả lời cho người thắng
        socket.on('auc_lockBidAndAnswer', (pin) => {
            const room = auctionRooms[pin];
            if (room && room.auctionType === 'question' && room.hostId === socket.id) {
                const auc = room.currentAuction;
                if (auc.highestBidderId) {
                    auc.status = 'answering';
                    const winner = room.players[auc.highestBidderId];
                    // Trừ tiền mua quyền trả lời ngay lập tức
                    winner.balance -= auc.highestBid;
                    io.to(room.hostId).emit('auc_updatePlayers', room.players);

                    // Báo toàn phòng: Ai đang trả lời và Gửi kèm nội dung câu hỏi để chiếu lên màn hình lớn
                    io.to(pin).emit('auc_waitingForWinner', { 
                        winnerName: auc.highestBidderName, 
                        bidAmount: auc.highestBid,
                        questionData: auc.questionData
                    });

                    // Bắn toàn bộ giao diện câu hỏi (kèm đáp án) CHO RIÊNG ĐIỆN THOẠI NGƯỜI THẮNG
                    io.to(auc.highestBidderId).emit('auc_winnerProvideAnswer', auc.questionData);
                } else {
                    room.currentAuction = null;
                    io.to(pin).emit('auc_questionEnded', { resultMsg: "⏳ Không có nhóm nào dám mua câu hỏi này!", players: room.players });
                }
            }
        });

        // Nhận kết quả từ người thắng
        socket.on('auc_submitWinnerAnswer', ({ pin, isCorrect }) => {
            const room = auctionRooms[pin];
            if (room && room.auctionType === 'question' && room.currentAuction) {
                const auc = room.currentAuction;
                const winner = room.players[auc.highestBidderId];
                let resultMsg = "";

                if (isCorrect) {
                    winner.balance += auc.reward; // Ăn tiền thưởng
                    resultMsg = `🎉 XUẤT SẮC! Nhóm [${winner.name}] đã trả lời ĐÚNG và ẵm trọn ${auc.reward}$ tiền thưởng!`;
                } else {
                    resultMsg = `💥 RẤT TIẾC! Nhóm [${winner.name}] trả lời SAI và làm bốc hơi ${auc.highestBid}$ tiền mua câu hỏi!`;
                }

                room.currentAuction = null;
                io.to(pin).emit('auc_questionEnded', { resultMsg, players: room.players });
                io.to(room.hostId).emit('auc_updatePlayers', room.players);
            }
        });

        // Nhận kết quả do Học sinh tự bấm trên điện thoại
        socket.on('auc_submitWinnerAnswerByStudent', ({ pin, isCorrect }) => {
            const room = auctionRooms[pin];
            if (room && room.auctionType === 'question' && room.currentAuction) {
                const auc = room.currentAuction;
                // Chỉ cho phép đúng người thắng được quyền gửi đáp án
                if (socket.id !== auc.highestBidderId) return;

                const winner = room.players[auc.highestBidderId];
                let resultMsg = "";

                if (isCorrect) {
                    winner.balance += auc.reward;
                    resultMsg = `🎉 XUẤT SẮC! Nhóm [${winner.name}] đã tự chốt ĐÚNG và ẵm trọn ${auc.reward}$ tiền thưởng!`;
                } else {
                    resultMsg = `💥 RẤT TIẾC! Nhóm [${winner.name}] đã bấm chốt SAI và làm bốc hơi ${auc.highestBid}$ tiền mua câu hỏi!`;
                }

                room.currentAuction = null;
                io.to(pin).emit('auc_questionEnded', { resultMsg, players: room.players });
                io.to(room.hostId).emit('auc_updatePlayers', room.players);
            }
        });

        // ==========================================
        // 🔹 DÙNG CHUNG: XỬ LÝ CHỐT GIÁ (BID)
        // ==========================================
        socket.on('auc_placeBid', ({ pin, amount }) => {
            const room = auctionRooms[pin];
            if (room && room.currentAuction && (room.currentAuction.status === 'bidding' || !room.currentAuction.status)) {
                const player = room.players[socket.id];
                if (player && amount > room.currentAuction.highestBid && amount <= player.balance) {
                    room.currentAuction.highestBid = amount;
                    room.currentAuction.highestBidderId = socket.id;
                    room.currentAuction.highestBidderName = player.name;
                    io.to(pin).emit('auc_newHighestBid', { amount: amount, bidderName: player.name });
                }
            }
        });

    });
};