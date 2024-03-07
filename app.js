const express = require('express');
const mysql = require('mysql');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const cheerio = require('cheerio');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 3000;
const useragent = require('express-useragent');

app.use(useragent.express());

//const connection = mysql.createConnection(db_url);
const connection = mysql.createConnection({
    host: 'host',
    user: 'user',
    password: 'password',
    database: 'database'
});
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));



app.use(bodyParser.json({
    verify(req, res, buf) {
        req.rawBody = buf.toString();
    }
}));

const config = {
    channelAccessToken: 'channelAccessToken',
    channelSecret: 'channelSecret'
};

const client = new line.Client(config);

app.post('/webhook', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

function handleEvent(event) {
    if (event.type === 'message' && event.message.type === 'text') {
        return handleText(event);
    }
    return Promise.resolve(null);
}

function handleText(event) {
    const text = event.message.text;

    //USerからUserId登録と送られたら
    if (text === "userId登録。") {
        return client.getProfile(event.source.userId)
            .then((profile) => {
                const userId = profile.userId;
                const userName = profile.displayName;

                // 既に登録されているか確認するクエリ
                const checkQuery = "SELECT * FROM students WHERE userid = ?";

                return new Promise((resolve, reject) => {
                    connection.query(checkQuery, [userId], (error, results) => {
                        if (error) {
                            console.error('DB error:', error);
                            reject(error);
                        } else {
                            if (results.length > 0) {
                                client.replyMessage(event.replyToken, {
                                    type: 'text',
                                    text: `こんにちは、${userName}さん。\nあなたはすでに登録されています。`
                                }).then(resolve).catch(reject);
                            } else {
                                //登録処理
                                const insertQuery = "INSERT INTO students (userid, name) VALUES (?, ?)";
                                connection.query(insertQuery, [userId, userName], (insertError, insertResults) => {
                                    if (insertError) {
                                        console.error('DB error:', insertError);
                                        reject(insertError);
                                    } else {
                                        client.replyMessage(event.replyToken, {
                                            type: 'text',
                                            text: `こんにちは、${userName}さん。登録が完了しました。`
                                        }).then(resolve).catch(reject);
                                    }
                                });
                            }
                        }
                    });
                });
            });
    }
}

connection.connect(err => {
    if (err) {
        console.error('Error connecting to ClearDB: ', err.stack);
        return;
    }
    console.log('Connected to ClearDB as id ', connection.threadId);
});

// 30秒ごとに実行する関数
function keepAlive() {
    connection.query('SELECT 1', (error, results) => {
        if (error) {
            //console.error('Error executing keep-alive query: ', error);
        } else {
            //console.log('Keep-alive query executed.');
        }
    });
}
setInterval(keepAlive, 30 * 1000);

app.get('/schedule', (req, res) => {
    const getScheduleQuery = `
        SELECT students.name, students.grade, subject_schedules.day_of_week, 
               subject_schedules.start_time, subjects.subject_name, 
               subject_schedules.end_time, subject_schedules.next_schedule_start_time
        FROM students 
        JOIN student_subjects ON students.student_id = student_subjects.student_id 
        JOIN subject_schedules ON student_subjects.selection_id = subject_schedules.selection_id 
        JOIN subjects ON student_subjects.subject_id = subjects.subject_id
        ORDER BY students.name, subject_schedules.start_time;
    `;

    connection.query(getScheduleQuery, (error, results) => {
        if (error) {
            console.error('DB error:', error);
            return res.status(500).send('Database error.');
        }

        const students = [...new Set(results.map(result => result.name))];

        const scheduleData = students.map(studentName => {
            const studentSchedules = results.filter(result => result.name === studentName);
            return {
                name: studentName,
                grade: studentSchedules[0].grade,
                schedules: studentSchedules.map(schedule => {
                    return {
                        name: schedule.name,
                        day_of_week: schedule.day_of_week,
                        start_time: schedule.start_time,
                        subject_name: schedule.subject_name,
                        end_time: schedule.end_time,
                        next_schedule_start_time: schedule.next_schedule_start_time
                    }
                })
            }
        });

        console.log(scheduleData);
        res.render('schedule', { scheduleData: scheduleData, students: students });
    });
});


app.get('/', (req, res) => {
    res.redirect('/top');
});

app.get('/Update_Information/:name/:Toaccess', (req, res) => {
    // URLに誰の情報を更新するのかという情報を含めておく
    const studentName = req.params.name;
    const anotherParameter = req.params.Toaccess;

    // URLから抜き出した生徒名をもとにその生徒の登録情報を取得
    const studentQuery = "SELECT * FROM students WHERE name = ?";
    connection.query(studentQuery, [studentName], (studentError, studentResults) => {
        if (studentError) {
            console.error('DB error:', studentError);
            return res.status(500).send('Database error.');
        }

        const student = studentResults[0];
        if (!student) {
            return res.status(404).send('Student not found.');
        }

        // 教科情報取得のためのクエリ
        const subjectQuery = `
        SELECT ss.selection_id, ss.subject_id, ssc.day_of_week, ssc.start_time
        FROM student_subjects ss
        LEFT JOIN subject_schedules ssc ON ss.selection_id = ssc.selection_id
        WHERE ss.student_id = ?
        `;
        connection.query(subjectQuery, [student.student_id], (subjectError, subjectResults) => {
            if (subjectError) {
                console.error('DB error:', subjectError);
                return res.status(500).send('Database error.');
            }

            // 教科IDと教科名のマッピング
            const subjectNames = {
                '4': '英語',
                '14': '数学',
                '24': '国語',
            };

            // 教科情報を整形
            const subjectInfo = {};
            subjectResults.forEach((subject) => {
                const day = subject.day_of_week;
                const time = subject.start_time;

                if (day && time) {
                    const subjectName = subjectNames[subject.subject_id];

                    if (!subjectInfo[day]) {
                        subjectInfo[day] = [];
                    }

                    let timeSlot = subjectInfo[day].find(slot => slot.start_time === time);

                    if (!timeSlot) {
                        timeSlot = { start_time: time, subjects: [] };
                        subjectInfo[day].push(timeSlot);
                    }

                    timeSlot.subjects.push(subjectName);
                }
            });

            const formInitialValues = {
                subjects: [],
                day1: '',
                time1: '',
                day2: '',
                time2: '',
                time_interval: student.time_interval // time_intervalの取得
            };

            let timeSlotCounter = 0;
            Object.keys(subjectInfo).forEach((day) => {
                subjectInfo[day].forEach(({ start_time, subjects }) => {
                    if (timeSlotCounter === 0) {
                        formInitialValues.day1 = day;
                        formInitialValues.time1 = start_time;
                    } else if (timeSlotCounter === 1) {
                        formInitialValues.day2 = day;
                        formInitialValues.time2 = start_time;
                    }
                    timeSlotCounter++;

                    subjects.forEach(subject => {
                        if (subject === '英語') formInitialValues.subjects.push('4');
                        if (subject === '数学') formInitialValues.subjects.push('14');
                        if (subject === '国語') formInitialValues.subjects.push('24');
                    });
                });
            });

            // レスポンスを送信
            res.render('update_student', { student: student, initialValues: formInitialValues, anotherParameter: anotherParameter });
        });
    });
});

app.get('/top', (req, res) => {
    res.render('top.ejs');
});

app.post('/Update_Information/:id/:Toaccess', (req, res) => {
    // URLパラメータからアクセス元と変更を行う生徒のIDを取得
    const studentId = req.params.id;
    const toAccess = req.params.Toaccess;

    // リクエストボディから必要な情報を抽出
    const { time_interval, name, school_type, grade: original_grade, userid, subjects, day1, time1, day2, time2 } = req.body;
    const interval = parseInt(time_interval);

    let grade;
    // 学年の作成(小学生以上は区分と学年で連結の必要があるため)
    if (["幼未", "年少", "年中", "年長"].includes(school_type)) {
        grade = school_type;
    } else {
        grade = `${school_type}${original_grade}`;
    }

    // 学生情報を更新するクエリ
    const updateStudentQuery = `
        UPDATE students 
        SET name = ?, grade = ?, userid = ?, week1 = ?, time1 = ?, week2 = ?, time2 = ?, time_interval = ? 
        WHERE student_id = ?`;
    // クエリ実行
    connection.query(updateStudentQuery, [name, grade, userid, day1, time1, day2, time2, time_interval, studentId], (error, results) => {
        if (error) {
            console.error('DB error:', error);
            return res.status(500).send('Database error.');
        }

        // 科目が存在するかチェック
        if (subjects && subjects.length > 0) {
            // 科目スケジュールを削除するクエリ
            const deleteScheduleQuery = "DELETE FROM subject_schedules WHERE selection_id IN (SELECT selection_id FROM student_subjects WHERE student_id=?)";
            connection.query(deleteScheduleQuery, [studentId], (error, results) => {
                if (error) {
                    console.error('DB error:', error);
                    return res.status(500).send('Database error.');
                }

                // 学生科目を削除するクエリ(すでに登録されているスケジュールがある場合、そのスケジュールを削除)
                const deleteSubjectsQuery = "DELETE FROM student_subjects WHERE student_id=?";
                // クエリ実行
                connection.query(deleteSubjectsQuery, [studentId], (error, results) => {
                    if (error) {
                        console.error('DB error:', error);
                        return res.status(500).send('Database error.');
                    }

                    // 新しい科目とスケジュールを挿入
                    subjects.forEach((subjectId) => {
                        // 学生科目を挿入するクエリ
                        const insertSubjectQuery = "INSERT INTO student_subjects (student_id, subject_id) VALUES (?, ?)";
                        // クエリ実行
                        connection.query(insertSubjectQuery, [studentId, subjectId], (error, results) => {
                            if (error) {
                                console.error('DB error:', error);
                                return res.status(500).send('Database error.');
                            }

                            const selectionId = results.insertId;

                            // 終了時間を計算する関数
                            const calculateTimes = (startTime, interval, subjects) => {
                                if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(startTime)) {
                                    throw new Error(`Invalid time format: ${startTime}`);
                                }

                                try {
                                    // 開始時間と終了時間を計算
                                    const startTimeDate = new Date(`1970-01-01T${startTime}:00.000Z`);
                                    const endTimeDate = new Date(startTimeDate.getTime() + interval * subjects.length * 60000);
                                    const endTime = endTimeDate.toISOString().substr(11, 5);

                                    const nextScheduleStartTimeDate = new Date(endTimeDate.getTime() + interval * 60000);
                                    const nextScheduleStartTime = nextScheduleStartTimeDate.toISOString().substr(11, 5);

                                    return [endTime, nextScheduleStartTime];
                                } catch (error) {
                                    console.error('Error calculating times:', error);
                                    throw error;
                                }
                            };

                            // 第1スケジュールの終了時間と次のスケジュールの開始時間を計算
                            const [endTime1, nextStartTime1] = calculateTimes(time1, interval, subjects);

                            // スケジュールを挿入するクエリ
                            const insertScheduleQuery = "INSERT INTO subject_schedules (selection_id, day_of_week, start_time, end_time, next_schedule_start_time) VALUES (?, ?, ?, ?, ?)";
                            // クエリ実行
                            connection.query(insertScheduleQuery, [selectionId, day1, time1, endTime1, nextStartTime1], (error, results) => {
                                if (error) {

                                    console.error('DB error:', error);
                                    return res.status(500).send('Database error.');
                                }

                                // 第2スケジュールが存在する場合のみ挿入
                                if (day2 && time2) {
                                    const [endTime2, nextStartTime2] = calculateTimes(time2, interval, subjects);
                                    // クエリ実行
                                    connection.query(insertScheduleQuery, [selectionId, day2, time2, endTime2, nextStartTime2], (error, results) => {
                                        if (error) {
                                            console.error('DB error:', error);
                                            return res.status(500).send('Database error.');
                                        }
                                    });
                                }
                            });
                        });
                    });
                    if (toAccess === 'management') {
                        res.redirect('/management?updated=true');
                    } else {
                        res.redirect('/' + toAccess);
                    }
                });
            });
        } else {
            if (toAccess === 'management') {
                res.redirect('/management?updated=true');
            } else {
                res.redirect('/' + toAccess);
            }
        }
    });
});


app.get('/management', (req, res) => {
    const { name, grade, week } = req.query;

    let queryParams = [];
    let whereConditions = [];

    if (name) {
        whereConditions.push("students.name LIKE ?");
        queryParams.push(`%${name}%`);
    }

    // 学年に対する条件を動的に構築
    if (grade) {
        // gradeはカンマ区切りの文字列または配列
        const grades = Array.isArray(grade) ? grade : grade.split(',');
        const gradeConditions = grades.map(() => "students.grade = ?").join(' OR ');
        whereConditions.push(`(${gradeConditions})`);
        queryParams = queryParams.concat(grades); // 各学年に対してパラメータを追加
    }

    // 曜日に対する条件を動的に構築
    if (week) {
        const weeks = Array.isArray(week) ? week : week.split(',');
        const weekConditions = weeks.map(() => "(students.week1 = ? OR students.week2 = ?)").join(' OR ');
        whereConditions.push(`(${weekConditions})`);
        weeks.forEach(wk => queryParams.push(wk, wk)); // 各曜日に対して2回ずつパラメータを追加
    }

    let whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    let schedulesQuery = `
    SELECT 
        students.student_id, 
        students.name, 
        students.grade,
        students.week1, 
        students.time1,
        students.week2, 
        students.time2,
        students.time_interval
    FROM students
    ${whereClause}
    ORDER BY students.student_id;
    `;

    connection.query(schedulesQuery, queryParams, (error, results) => {
        if (error) {
            console.error('DB error:', error);
            return res.status(500).send('Database error.');
        }

        res.render('management', { students: results });
    });
});





app.get('/student_days/:studentId', (req, res) => {
    const studentId = req.params.studentId;
    // 生徒の曜日情報を取得するクエリを実行
    const query = `SELECT DISTINCT subject_schedules.day_of_week FROM student_subjects
                   JOIN subject_schedules ON student_subjects.selection_id = subject_schedules.selection_id
                   WHERE student_subjects.student_id = ?`;
    connection.query(query, [studentId], (error, results) => {
        if (error) {
            return res.status(500).send('Database error.');
        }
        // 結果をJSON形式で返す
        res.json(results);
    });
});



app.get('/message', (req, res) => {
    const { name, grade, notInIds } = req.query;
    let query = "SELECT * FROM students";
    let queryParams = [];
    let conditions = [];

    if (notInIds) {
        conditions.push(`student_id NOT IN (${JSON.parse(notInIds).join(',')})`);
    }

    if (name) {
        conditions.push("students.name LIKE ?");
        queryParams.push("%" + name + "%");
    }

    if (Array.isArray(grade) && grade.length > 0) {
        conditions.push(`students.grade IN (${grade.map(() => '?').join(', ')})`);
        queryParams.push(...grade);
    } else if (typeof grade === 'string' && grade) {
        // 単一の学年が選択された場合
        conditions.push("students.grade = ?");
        queryParams.push(grade);
    }

    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }

    // 学校のリストを取得
    connection.query("SELECT DISTINCT school FROM students", (error, schoolResults) => {
        if (error) {
            console.error('DB error:', error);
            res.status(500).send('Database error.');
        } else {
            // 生徒を検索
            connection.query(query, queryParams, (error, studentResults) => {
                if (error) {
                    console.error('DB error:', error);
                    res.status(500).send('Database error.');
                } else {
                    global.variable_userIds = [];
                    global.variable_userIds = studentResults.map(student => student.userid);
                    const userAgent = req.headers['user-agent'].toLowerCase();
                    const isDesktop = /windows nt|linux/i.test(userAgent);
                    let viewName = isDesktop ? 'index' : 'index_mobile';
                    res.render(viewName, { students: studentResults, schools: schoolResults });
                }
            });
        }
    });
});

app.post('/send_message', (req, res) => {
    let message = req.body.message;
    message = message.replace(/<br>/g, '\n');
    const $ = cheerio.load(message);
    const link = $('a').attr('href');
    const image = $('img').attr('src');
    const text = $('p').text();

    console.log('Link:', link);
    console.log('Image:', image);
    console.log('Text:', text);

    let lineMessage;
    let messageType = 'text';  // Default to text

    if (link && image && text) {
        messageType = 'image_link';
        lineMessage = {
            type: 'template',
            altText: 'this is a buttons template',
            template: {
                type: 'buttons',
                thumbnailImageUrl: image,
                title: 'Link and text',
                text: text,
                actions: [
                    {
                        type: 'uri',
                        label: 'View detail',
                        uri: link
                    }
                ]
            }
        };
    } else if (link && image) {
        messageType = 'image_link';
        lineMessage = {
            type: 'template',
            altText: 'this is image and link',
            template: {
                type: 'buttons',
                thumbnailImageUrl: image,
                title: 'リンク付き画像',
                text: 'クリックしてリンクを開く',
                actions: [
                    {
                        type: 'uri',
                        label: '開く',
                        uri: link
                    }
                ]
            }
        };
    } else if (image) {
        messageType = 'image_link';
        lineMessage = {
            type: 'image',
            originalContentUrl: image,
            previewImageUrl: image
        };
    } else if (text) {
        lineMessage = {
            type: 'text',
            text: text
        };
    }
    console.log(global.variable_userIds);
    const uniqueUserIds = new Set(global.variable_userIds);

    for (let userId of uniqueUserIds) {
        console.log(userId);
        console.log(lineMessage);
        client.pushMessage(userId, lineMessage)
            .then(() => {
                console.log(`Message sent to ${userId}`);
            })
            .catch((err) => {
                console.error(`Error sending message to ${userId}:`, err);
            });
    }

    res.redirect('/line_message');
});



app.post('/duplicate_student', async (req, res) => {
    console.log(req.body);
    try {
        const { studentId } = req.body;

        if (!studentId) {
            return res.json({ success: false, message: 'Student ID is required.' });
        }

        // データベースから元のデータを取得します
        const originalData = await getStudentDataFromDatabase(studentId);
        if (!originalData) {
            return res.json({ success: false, message: 'Original data not found.' });
        }

        // データを複製してデータベースに追加します
        await addStudentDataToDatabase(originalData);

        res.json({ success: true });
    } catch (error) {
        console.error('Error duplicating data:', error);
        res.json({ success: false, message: 'Server error.' });
    }
});

async function getStudentDataFromDatabase(studentId) {
    return new Promise((resolve, reject) => {
        const query = 'SELECT * FROM students WHERE student_id = ?';
        connection.query(query, [studentId], (err, results) => {
            if (err) {
                return reject(err);
            }
            resolve(results[0]);
        });
    });
}

async function addStudentDataToDatabase(studentData) {
    return new Promise((resolve, reject) => {
        const { student_id, ...dataToDuplicate } = studentData;
        const query = 'INSERT INTO students SET ?';
        connection.query(query, dataToDuplicate, (err, result) => {
            if (err) {
                return reject(err);
            }
            resolve(result);
        });
    });
}



app.listen(port, () => {
    console.log(`App is running on port ${port}`);
});

// 終了時の処理
process.on('exit', (code) => {
    connection.end();
    console.log('ClearDB connection closed.');
});
