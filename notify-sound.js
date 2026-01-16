/**
 * 任务完成发声提醒脚本
 * 当Claude Code完成任务时播放系统提示音
 * 支持根据不同事件类型播放不同语音
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * 事件类型对应的语音内容
 */
const EVENT_VOICE_MAP = {
    'Stop': '任务完成',
    'permission_prompt': '需要权限确认',
    'idle_prompt': '等待你的输入',
    'elicitation_dialog': '需要输入信息',
    'SubagentStop': '子任务完成',
    'default': '任务完成'
};

/**
 * 事件类型对应的蜂鸣音调 (Hz)
 */
const EVENT_BEEP_MAP = {
    'Stop': 600,           // 低音 - 完成，不紧急
    'permission_prompt': 1000,  // 高音 - 需要操作
    'idle_prompt': 800,    // 中音 - 等待中
    'elicitation_dialog': 900,  // 中高音 - 需要输入
    'SubagentStop': 700,   // 中低音 - 子任务
    'default': 800
};

/**
 * 获取事件类型的语音内容
 * @param {string} eventType - 事件类型
 * @param {string} notificationType - 通知类型 (用于 Notification 事件)
 * @returns {string} 语音内容
 */
function getVoiceText(eventType, notificationType = null) {
    // 如果是 Notification 事件，使用 notificationType
    if (eventType === 'Notification' && notificationType) {
        return EVENT_VOICE_MAP[notificationType] || EVENT_VOICE_MAP['default'];
    }
    return EVENT_VOICE_MAP[eventType] || EVENT_VOICE_MAP['default'];
}

/**
 * 获取事件类型的蜂鸣音调
 * @param {string} eventType - 事件类型
 * @param {string} notificationType - 通知类型
 * @returns {number} 音调频率 (Hz)
 */
function getBeepFrequency(eventType, notificationType = null) {
    if (eventType === 'Notification' && notificationType) {
        return EVENT_BEEP_MAP[notificationType] || EVENT_BEEP_MAP['default'];
    }
    return EVENT_BEEP_MAP[eventType] || EVENT_BEEP_MAP['default'];
}

/**
 * 播放Windows系统提示音
 * @param {string} voiceText - 要播放的语音内容
 * @param {number} beepFreq - 蜂鸣音调频率
 */
function playWindowsSound(voiceText = '任务完成', beepFreq = 800) {
    const psScript = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("${voiceText}"); [console]::Beep(${beepFreq}, 300)`;

    return spawn('powershell', ['-Command', psScript], {
        stdio: 'ignore',
        shell: false
    });
}

/**
 * 播放简单的蜂鸣声作为备用方案
 * @param {number} frequency - 音调频率
 */
function playBeep(frequency = 800) {
    const psScript = `[console]::Beep(${frequency}, 500)`;

    return spawn('powershell', ['-Command', psScript], {
        stdio: 'ignore',
        shell: false
    });
}

/**
 * 主要的提醒函数
 * @param {string} eventType - 事件类型 (Stop, Notification, SubagentStop)
 * @param {string} notificationType - 通知类型 (permission_prompt, idle_prompt, elicitation_dialog)
 */
function notifyTaskCompletion(eventType = 'default', notificationType = null) {
    const voiceText = getVoiceText(eventType, notificationType);
    const beepFreq = getBeepFrequency(eventType, notificationType);

    console.log(`🎵 播放提醒声音: "${voiceText}" (${beepFreq}Hz)`);

    try {
        const soundProcess = playWindowsSound(voiceText, beepFreq);

        soundProcess.on('error', (error) => {
            console.log('系统声音播放失败，使用蜂鸣声:', error.message);
            playBeep(beepFreq);
        });

        soundProcess.on('close', (code) => {
            if (code !== 0) {
                console.log('系统声音进程异常退出，使用蜂鸣声');
                playBeep(beepFreq);
            }
        });

    } catch (error) {
        console.log('播放声音时发生错误，使用蜂鸣声:', error.message);
        playBeep(beepFreq);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    // 支持命令行参数
    const args = process.argv.slice(2);
    let eventType = 'default';
    let notificationType = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--event' && args[i + 1]) {
            eventType = args[i + 1];
            i++;
        } else if (args[i] === '--type' && args[i + 1]) {
            notificationType = args[i + 1];
            i++;
        }
    }

    notifyTaskCompletion(eventType, notificationType);

    // 3秒后退出程序
    setTimeout(() => {
        console.log('提醒完成，程序退出');
        process.exit(0);
    }, 3000);
}

module.exports = {
    notifyTaskCompletion,
    playWindowsSound,
    playBeep,
    getVoiceText,
    getBeepFrequency,
    EVENT_VOICE_MAP,
    EVENT_BEEP_MAP
};