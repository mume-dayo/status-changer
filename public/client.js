const getEl = (id) => document.getElementById(id);
const tokenInput = getEl('token');
const activityTypeSelect = getEl('activityType');
const spotifyUrlInput = getEl('spotifyUrl');
const activityNameInput = getEl('activityName');
const activityDetailsInput = getEl('activityDetails');
const activityStateInput = getEl('activityState');
const form = getEl('statusForm');
const submitBtn = getEl('submitBtn');
const disconnectBtn = getEl('disconnectBtn');
const logEl = getEl('log');

let sessionId = null;
let statusCheckInterval = null;

function appendLog(message) {
    const timestamp = new Date().toLocaleTimeString('ja-JP');
    logEl.textContent += `\n[${timestamp}] ${message}`;
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function setControlsState(connected) {
    submitBtn.textContent = connected ? 'ステータス更新' : 'ステータス設定';
    disconnectBtn.disabled = !connected;
    tokenInput.disabled = connected;
}


async function connectToServer() {
    const token = tokenInput.value.trim();

    if (!token) {
        appendLog('トークンを入力してね');
        return;
    }

    try {
        appendLog('サーバーに接続中...');

        const response = await fetch('/api/connect', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token })
        });

        const data = await response.json();

        if (response.ok) {
            sessionId = data.sessionId;
            appendLog('接続に成功しました');
            appendLog(`Session ID: ${sessionId}`);
            setControlsState(true);

            startStatusCheck();

            await updateStatus();
        } else {
            appendLog(`接続エラー: ${data.error}`);
            if (data.message) {
                appendLog(`詳細: ${data.message}`);
            }
        }
    } catch (error) {
        appendLog(`ネットワークエラー: ${error.message}`);
    }
}

async function fetchSpotifyInfo(url) {
    try {
        appendLog('Spotify情報を取得中...');

        const response = await fetch(`/api/spotify-info?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (response.ok) {
            appendLog(`曲情報取得: ${data.songName} - ${data.artistName}`);
            return data;
        } else {
            appendLog(`Spotify情報取得エラー: ${data.error}`);
            return null;
        }
    } catch (error) {
        appendLog(`ネットワークエラー: ${error.message}`);
        return null;
    }
}

async function updateStatus() {
    if (!sessionId) {
        appendLog('先に接続してね');
        return;
    }

    let activity = {
        name: activityNameInput.value.trim(),
        type: activityTypeSelect.value,
        details: activityDetailsInput.value.trim(),
        state: activityStateInput.value.trim()
    };

    const spotifyUrl = spotifyUrlInput.value.trim();
    if (spotifyUrl) {
        const spotifyInfo = await fetchSpotifyInfo(spotifyUrl);

        if (spotifyInfo) {
            if (!activity.name) {
                activity.name = spotifyInfo.songName;
            }
            if (!activity.state) {
                activity.state = `by ${spotifyInfo.artistName}`;
            }
            if (spotifyInfo.spotifyImageId) {
                activity.imageUrl = `spotify:${spotifyInfo.spotifyImageId}`;
                activity.imageText = spotifyInfo.songName;
            }
        }
    }

    try {
        appendLog('ステータスを更新中...');

        const response = await fetch('/api/update-status', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sessionId,
                activity: activity.name ? activity : {}
            })
        });

        const data = await response.json();

        if (response.ok) {
            appendLog(activity.name ? 'ステータスを更新しました' : 'ステータスをクリアしました');
        } else {
            appendLog(`更新エラー: ${data.error}`);
        }
    } catch (error) {
        appendLog(`ネットワークエラー: ${error.message}`);
    }
}

async function disconnect() {
    if (!sessionId) {
        return;
    }

    try {
        appendLog('切断中...');

        const response = await fetch('/api/disconnect', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sessionId })
        });

        const data = await response.json();

        if (response.ok) {
            appendLog('切断しました');
            sessionId = null;
            setControlsState(false);
            stopStatusCheck();
        } else {
            appendLog(`切断エラー: ${data.error}`);
        }
    } catch (error) {
        appendLog(`ネットワークエラー: ${error.message}`);
    }
}

function startStatusCheck() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
    }

    statusCheckInterval = setInterval(async () => {
        if (!sessionId) {
            stopStatusCheck();
            return;
        }

        try {
            const response = await fetch(`/api/status/${sessionId}`);
            const data = await response.json();

            if (!data.connected && sessionId) {
                appendLog('接続が切断されました。再接続中...');
            }
        } catch (error) {
            console.error('Status check error:', error);
        }
    }, 5000);
}

function stopStatusCheck() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
        statusCheckInterval = null;
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (sessionId) {
        await updateStatus();
    } else {
        await connectToServer();
    }
});

disconnectBtn.addEventListener('click', disconnect);

setControlsState(false);
appendLog('アイコン設定できるよ、それだけ');

window.addEventListener('beforeunload', (e) => {
    if (sessionId) {
        e.preventDefault();
        e.returnValue = '切断ボタン押さないと接続され続けるよ';
    }
});
