/**
 * Telegram通知脚本
 * 通过Telegram Bot API发送消息通知
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { envConfig } = require('./env-config');

/**
 * 格式化时间为 MM-DD HH:mm
 * @param {Date} date - 日期对象
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * 从任务信息推断状态
 * @param {string} taskInfo - 任务信息文本
 * @returns {string} 状态：'完成' | '失败' | '等待输入'
 */
function inferStatusFromText(taskInfo) {
    // 入参兜底
    taskInfo = String(taskInfo ?? '');
    const text = taskInfo.toLowerCase();

    // 等待输入关键词（移除过于宽泛的"确认"）
    if (text.includes('permission') || text.includes('权限') ||
        text.includes('idle') || text.includes('等待') ||
        text.includes('elicitation') || text.includes('请输入')) {
        return '等待输入';
    }

    // 失败关键词
    if (text.includes('error') || text.includes('失败') ||
        text.includes('exception') || text.includes('502') ||
        text.includes('bad gateway') || /http\s*5\d{2}/.test(text)) {
        return '失败';
    }

    return '完成';
}

/**
 * HTML 转义函数
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    // 入参兜底
    text = String(text ?? '');
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Telegram通知类
 */
class TelegramNotifier {
    /**
     * 构造函数
     */
    constructor() {
        // 使用统一的环境变量配置
        const telegramConfig = envConfig.getTelegramConfig();

        this.botToken = telegramConfig.bot_token;
        this.chatId = telegramConfig.chat_id;
        this.proxyUrl = telegramConfig.proxy_url;
        this.enabled = this._loadConfig();

        if (this.enabled) {
            if (!this.botToken || !this.chatId) {
                console.log('⚠️  Telegram通知已启用但配置不完整，请检查TELEGRAM_BOT_TOKEN和TELEGRAM_CHAT_ID');
                this.enabled = false;
            } else {
                this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
                if (this.proxyUrl) {
                    console.log(`✅ Telegram通知已启用（使用代理: ${this.proxyUrl}）`);
                } else {
                    console.log('✅ Telegram通知已启用');
                }
            }
        } else {
            console.log('ℹ️  Telegram通知未启用');
        }
    }

    /**
     * 从config.json加载配置
     * @returns {boolean} 是否启用
     */
    _loadConfig() {
        try {
            const configPath = path.join(__dirname, 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                return config.notification?.telegram?.enabled || false;
            }
        } catch (error) {
            console.error('⚠️  读取config.json失败:', error.message);
        }
        return false;
    }

    /**
     * 发送消息到Telegram
     * @param {string} message - 消息内容
     * @param {string} parseMode - 消息解析模式 ("HTML" 或 "Markdown")
     * @returns {Promise<boolean>} 发送是否成功
     */
    async sendMessage(message, parseMode = 'HTML') {
        if (!this.enabled) {
            console.log('ℹ️  Telegram通知未启用，跳过发送');
            return false;
        }

        const payload = {
            chat_id: this.chatId,
            text: message,
            parse_mode: parseMode,
            disable_web_page_preview: false
        };

        return this._sendPayload('/sendMessage', payload);
    }

    /**
     * 发送HTTP请求到Telegram API
     * @param {string} endpoint - API端点
     * @param {Object} payload - 请求载荷
     * @returns {Promise<boolean>} 发送是否成功
     */
    _sendPayload(endpoint, payload) {
        return new Promise((resolve) => {
            const data = JSON.stringify(payload);
            const apiUrl = new URL(this.baseUrl + endpoint);

            if (this.proxyUrl) {
                // 使用代理 - 通过CONNECT建立隧道
                this._sendViaProxy(apiUrl, data, resolve);
            } else {
                // 直连
                this._sendDirect(apiUrl, data, resolve);
            }
        });
    }

    /**
     * 直连发送请求
     */
    _sendDirect(apiUrl, data, resolve) {
        const options = {
            hostname: apiUrl.hostname,
            path: apiUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            this._handleResponse(res, resolve);
        });

        req.on('error', (error) => {
            console.error('❌ 发送Telegram请求失败:', error.message);
            resolve(false);
        });

        req.write(data);
        req.end();
    }

    /**
     * 通过代理发送请求
     */
    _sendViaProxy(apiUrl, data, resolve) {
        const proxy = new URL(this.proxyUrl);

        // 步骤1: 发送CONNECT请求建立隧道
        const connectOptions = {
            hostname: proxy.hostname,
            port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            method: 'CONNECT',
            path: `${apiUrl.hostname}:443`,
            headers: {}
        };

        // 如果代理有认证信息
        if (proxy.username && proxy.password) {
            const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
            connectOptions.headers['Proxy-Authorization'] = `Basic ${auth}`;
        }

        const proxyProtocol = proxy.protocol === 'https:' ? https : http;
        const connectReq = proxyProtocol.request(connectOptions);

        connectReq.on('connect', (res, socket) => {
            if (res.statusCode === 200) {
                // 隧道建立成功，通过隧道发送HTTPS请求
                const tlsOptions = {
                    socket: socket,
                    servername: apiUrl.hostname
                };

                const httpsReq = https.request({
                    ...tlsOptions,
                    method: 'POST',
                    path: apiUrl.pathname,
                    headers: {
                        'Host': apiUrl.hostname,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                }, (response) => {
                    this._handleResponse(response, resolve);
                });

                httpsReq.on('error', (error) => {
                    console.error('❌ 通过代理发送请求失败:', error.message);
                    resolve(false);
                });

                httpsReq.write(data);
                httpsReq.end();
            } else {
                console.error(`❌ 代理连接失败: HTTP ${res.statusCode}`);
                resolve(false);
            }
        });

        connectReq.on('error', (error) => {
            console.error('❌ 连接代理服务器失败:', error.message);
            resolve(false);
        });

        connectReq.end();
    }

    /**
     * 处理响应
     */
    _handleResponse(res, resolve) {
        let responseData = '';

        res.on('data', (chunk) => {
            responseData += chunk;
        });

        res.on('end', () => {
            try {
                const result = JSON.parse(responseData);
                if (result.ok) {
                    console.log('✅ Telegram消息发送成功');
                    resolve(true);
                } else {
                    console.error('❌ Telegram消息发送失败:', result.description);
                    resolve(false);
                }
            } catch (error) {
                console.error('❌ 解析Telegram响应失败:', error.message);
                console.error('响应内容:', responseData.substring(0, 200));
                resolve(false);
            }
        });
    }
}

/**
 * 任务完成通知函数
 * @param {string} taskInfo - 任务信息
 * @param {string} projectName - 项目名称
 * @returns {Promise<boolean>} 发送是否成功
 */
async function notifyTaskCompletion(taskInfo = "Claude Code任务已完成", projectName = "") {
    const notifier = new TelegramNotifier();

    if (!notifier.enabled) {
        console.log('⚠️  请先配置Telegram通知');
        console.log('📝 配置方法：');
        console.log('1. 与 @BotFather 对话创建机器人，获取 token');
        console.log('2. 将机器人添加到频道/群组，或直接与机器人对话');
        console.log('3. 获取 chat_id');
        console.log('4. 在 .env 文件中设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID');
        console.log('5. 在 config.json 中将 notification.telegram.enabled 设为 true');
        return false;
    }

    // 推断状态
    const status = inferStatusFromText(taskInfo);
    const formattedTime = formatTime(new Date());

    // 标题：【状态】项目名
    const title = projectName ? `【${status}】${projectName}` : `【${status}】任务通知`;

    // 计算固定头部长度
    const headerPrefix = `<b>${escapeHtml(title)}</b>\n■ 时间：${formattedTime}\n`;
    let headerSuffix = '';
    let fieldLabel = '';

    if (status === '失败') {
        fieldLabel = '<b>错误</b>：';
    } else if (status === '等待输入') {
        headerSuffix = '■ 原因：需要你的输入\n';
        fieldLabel = '■ 详情：';
    } else {
        headerSuffix = '■ 状态：任务已完成\n';
        fieldLabel = '■ 详情：';
    }

    const fixedLength = headerPrefix.length + headerSuffix.length + fieldLabel.length;
    const maxContentLength = 4096 - fixedLength - 10; // 预留 10 字符安全边界

    // 裁剪 taskInfo 并转义
    let contentText = taskInfo;
    if (contentText.length > maxContentLength) {
        contentText = contentText.slice(0, maxContentLength) + '...';
    }
    const escapedContent = escapeHtml(contentText);

    // 组装消息
    let message = headerPrefix + headerSuffix + fieldLabel + escapedContent;

    try {
        const success = await notifier.sendMessage(message);

        if (success) {
            console.log('🎉 任务完成通知已发送到Telegram！');
        } else {
            console.log('❌ Telegram通知发送失败，请检查配置');
        }

        return success;
    } catch (error) {
        console.error('❌ 发送Telegram通知时发生错误:', error.message);
        return false;
    }
}

/**
 * 获取命令行参数
 */
function getCommandLineArgs() {
    const args = process.argv.slice(2);
    const options = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
            options[key] = value;
            if (value !== true) i++; // 跳过下一个参数
        }
    }

    return options;
}

// 如果直接运行此脚本
if (require.main === module) {
    const options = getCommandLineArgs();
    const taskInfo = options.message || options.task || "Claude Code任务已完成";

    console.log('🚀 开始发送Telegram通知...');
    notifyTaskCompletion(taskInfo);
}

module.exports = {
    TelegramNotifier,
    notifyTaskCompletion
};
