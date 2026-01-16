/**
 * Claude Code 任务完成通知系统
 * 集成声音提醒和飞书推送，支持手环震动
 * 支持从 stdin 读取 hook 输入数据
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { envConfig } = require('./env-config');
const { NotificationManager } = require('./notification-manager');
const { notifyTaskCompletion } = require('./notify-sound');

/**
 * 从 stdin 读取 hook 输入的 JSON 数据
 * @returns {Promise<object|null>} 解析后的 JSON 对象，如果没有输入则返回 null
 */
async function readStdinJson() {
    return new Promise((resolve) => {
        // 检查 stdin 是否有数据（非 TTY 模式）
        if (process.stdin.isTTY) {
            resolve(null);
            return;
        }

        let data = '';
        const rl = readline.createInterface({
            input: process.stdin,
            terminal: false
        });

        const timeout = setTimeout(() => {
            rl.close();
            resolve(null);
        }, 1000); // 1秒超时

        rl.on('line', (line) => {
            data += line;
        });

        rl.on('close', () => {
            clearTimeout(timeout);
            if (data.trim()) {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    console.log('⚠️  无法解析 stdin JSON:', e.message);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });

        rl.on('error', () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
}

/**
 * 从 transcript 文件提取任务摘要
 * @param {string} transcriptPath - transcript 文件路径
 * @returns {string|null} 任务摘要
 */
function extractTaskSummary(transcriptPath) {
    try {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            return null;
        }

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // 从后往前找最后一条 assistant 消息
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'assistant' && entry.message?.content) {
                    // 提取文本内容
                    const textContent = entry.message.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('\n');

                    if (textContent) {
                        // 截取前100个字符作为摘要
                        const summary = textContent.slice(0, 100).replace(/\n/g, ' ').trim();
                        return summary + (textContent.length > 100 ? '...' : '');
                    }
                }
            } catch (e) {
                // 跳过无法解析的行
            }
        }
        return null;
    } catch (error) {
        console.log('⚠️  读取 transcript 失败:', error.message);
        return null;
    }
}

/**
 * 通知系统管理器
 */
class NotificationSystem {
    constructor(hookInput = null) {
        this.hookInput = hookInput;
        this.config = this.loadConfig();
        this.projectName = this.getProjectName();
        this.notificationManager = new NotificationManager(this.config, this.projectName);
    }

    /**
     * 加载配置文件
     */
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configData);

            // 从环境变量配置覆盖配置文件
            const envVars = envConfig.getAllConfig();

            // 飞书配置
            if (envVars.feishu.webhook_url) {
                config.notification.feishu.webhook_url = envVars.feishu.webhook_url;
                config.notification.feishu.enabled = true;
            }

            // Telegram配置
            if (envVars.telegram.enabled) {
                config.notification.telegram = {
                    ...config.notification.telegram,
                    ...envVars.telegram,
                    enabled: true
                };
            }

            // 声音配置
            if (process.env.SOUND_ENABLED !== undefined) {
                config.notification.sound.enabled = envVars.sound.enabled;
            }

            return config;
        } catch (error) {
            console.log('⚠️  无法加载配置文件，使用环境变量配置');
            const envVars = envConfig.getAllConfig();
            return {
                notification: {
                    type: envVars.feishu.enabled ? 'feishu' : 'sound',
                    feishu: envVars.feishu,
                    telegram: envVars.telegram,
                    sound: envVars.sound
                }
            };
        }
    }

    /**
     * 获取项目名称
     * 优先级: hook输入的cwd > package.json > git仓库名 > 目录名
     */
    getProjectName() {
        try {
            // 优先使用 hook 输入的 cwd
            const workDir = this.hookInput?.cwd || process.cwd();

            // 1. 尝试从工作目录的 package.json 获取项目名称
            const packageJsonPath = path.join(workDir, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                if (packageData.name) {
                    console.log(`📦 从 package.json 检测到项目名称: ${packageData.name}`);
                    return packageData.name;
                }
            }

            // 2. 尝试从 git 仓库名获取
            const { execSync } = require('child_process');
            try {
                const gitRemote = execSync('git remote get-url origin', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    cwd: workDir
                }).trim();
                // 从 git URL 提取仓库名
                const matches = gitRemote.match(/\/([^\/]+?)(\.git)?$/);
                if (matches && matches[1]) {
                    console.log(`🔧 从 git 仓库检测到项目名称: ${matches[1]}`);
                    return matches[1];
                }
            } catch (gitError) {
                // git 命令失败，继续下一步
            }

            // 3. 从目录名获取
            const dirName = path.basename(workDir);
            console.log(`📁 从目录名检测到项目名称: ${dirName}`);
            return dirName;

        } catch (error) {
            console.log('⚠️  无法获取项目名称，使用默认值');
            return '未知项目';
        }
    }

    /**
     * 播放Windows系统声音
     */
    playWindowsSound() {
        const psScript = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("任务完成，已发送手机通知"); [console]::Beep(800, 300)`;

        return spawn('powershell', ['-Command', psScript], {
            stdio: 'ignore',
            shell: false
        });
    }

    /**
     * 播放蜂鸣声作为备用方案
     */
    playBeep() {
        const psScript = '[console]::Beep(800, 500)';
        return spawn('powershell', ['-Command', psScript], {
            stdio: 'ignore',
            shell: false
        });
    }

    /**
     * 发送声音提醒
     */
    async sendSoundNotification() {
        if (!this.config.notification.sound.enabled) {
            return;
        }

        // 获取事件类型
        const eventType = this.hookInput?.hook_event_name || 'default';
        const notificationType = this.hookInput?.notification_type || null;

        console.log('🔊 播放声音提醒...');

        try {
            // 使用 notify-sound 模块，传递事件类型
            notifyTaskCompletion(eventType, notificationType);
        } catch (error) {
            console.log('播放声音时发生错误:', error.message);
        }
    }

    /**
     * 发送飞书通知
     */
    async sendFeishuNotification(taskInfo) {
        if (!this.config.notification.feishu.enabled) {
            console.log('📱 飞书通知已禁用');
            return false;
        }

        const webhookUrl = this.config.notification.feishu.webhook_url;

        if (!webhookUrl || webhookUrl.includes('YOUR_WEBHOOK_URL_HERE')) {
            console.log('⚠️  请先配置飞书webhook地址');
            this.printFeishuSetupGuide();
            return false;
        }

        return await sendFeishuNotification(taskInfo, webhookUrl, this.projectName);
    }

    /**
     * 根据 hook 输入生成通知消息
     * @param {string} fallbackMessage - 命令行传入的备用消息
     * @returns {string} 最终的通知消息
     */
    generateMessage(fallbackMessage) {
        if (!this.hookInput) {
            return fallbackMessage;
        }

        const eventName = this.hookInput.hook_event_name;
        const notificationType = this.hookInput.notification_type;

        // Notification 事件：使用实际的 message 字段
        if (eventName === 'Notification' && this.hookInput.message) {
            return this.hookInput.message;
        }

        // Stop 事件：尝试从 transcript 提取摘要
        if (eventName === 'Stop') {
            const summary = extractTaskSummary(this.hookInput.transcript_path);
            if (summary) {
                return `已完成: ${summary}`;
            }
            return '任务已完成';
        }

        // SubagentStop 事件
        if (eventName === 'SubagentStop') {
            const summary = extractTaskSummary(this.hookInput.transcript_path);
            if (summary) {
                return `子任务完成: ${summary}`;
            }
            return '子任务已完成';
        }

        return fallbackMessage;
    }

    /**
     * 发送所有类型的通知
     */
    async sendAllNotifications(taskInfo = "Claude Code任务已完成") {
        // 使用 hook 输入生成更精确的消息
        const message = this.generateMessage(taskInfo);

        const icons = this.notificationManager.getEnabledNotificationIcons();
        console.log(`🚀 开始发送通知... ${icons}`);
        console.log(`📁 项目名称：${this.projectName}`);
        console.log(`📝 通知内容：${message}`);

        if (this.hookInput) {
            console.log(`🔔 事件类型：${this.hookInput.hook_event_name}${this.hookInput.notification_type ? ` (${this.hookInput.notification_type})` : ''}`);
        }

        // 发送所有通知
        const results = await this.notificationManager.sendAllNotifications(message);

        // 添加声音通知
        if (this.config.notification.sound.enabled) {
            this.sendSoundNotification();
            setTimeout(() => {
                console.log('🔊 声音提醒已播放');
            }, 1000);
        }

        // 打印结果汇总
        this.notificationManager.printNotificationSummary(results);

        // 3秒后退出
        setTimeout(() => {
            console.log('✨ 通知系统执行完成，程序退出');
            process.exit(0);
        }, 3000);
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
            if (value !== true) i++;
        }
    }

    return options;
}

// 如果直接运行此脚本
if (require.main === module) {
    (async () => {
        const options = getCommandLineArgs();
        const fallbackMessage = options.message || options.task || "Claude Code任务已完成";

        // 尝试从 stdin 读取 hook 输入
        const hookInput = await readStdinJson();

        if (hookInput) {
            console.log('📥 收到 hook 输入数据');
        }

        const notifier = new NotificationSystem(hookInput);
        notifier.sendAllNotifications(fallbackMessage);
    })();
}

module.exports = {
    NotificationSystem,
    readStdinJson,
    extractTaskSummary
};