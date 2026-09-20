#!/usr/bin/env node
'use strict';
// 一键检查：用真实的 163 邮箱发一封验证码邮件，确认 SMTP 配置能不能跑通。
//
// 用法（在项目根目录下执行）：
//     node smtp-check.js
//
// 它会依次问你三个问题，然后调用平台真正在用的那套发信代码
// （platform/mail.js 的 sendVerification），完整走一遍：
//    连接 smtp.163.com:465 → TLS 握手 → EHLO → 登录 → 投递
// 这样测出来的结果就是上线后的真实行为，不是近似模拟。
//
// 本工具不会修改任何文件，也不会把邮箱或授权码写到哪里去。

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const mail = require('./platform/mail');

const LOCAL_FILE = path.join(__dirname, 'smtp-local.json');

const STAGE_TEXT = {
  connect: '连不上 smtp.163.com:465（网络或防火墙挡住了）',
  greeting: '服务器连上了，但没回欢迎语',
  ehlo: '服务器在 EHLO 这一步拒绝了我们',
  starttls: '服务器不支持 STARTTLS',
  ehlo_tls: 'TLS 建立后重新 EHLO 时被拒绝',
  auth: '登录被拒绝（多半是授权码不对）',
  mail_from: '服务器不接受我们填的发件人地址',
  rcpt_to: '服务器不接受收件人地址',
  data: '开始投递正文时被拒绝',
  data_result: '正文发出后服务器没有确认接收',
  quit: '收尾阶段出错（不影响投递结果）',
  prepare: '提交给发信程序的内容不合法',
  config: '发信配置本身有问题',
  accepted: '全部通过',
};

const REASON_TEXT = {
  smtp_535: '授权码不正确，或者这个邮箱的 SMTP 服务没有真正开启',
  smtp_550: '服务器拒收：可能是发件人地址与认证账号不一致，也可能是内容被判为垃圾邮件',
  smtp_553: '发件人地址与认证账号不一致',
  smtp_554: '这个出口 IP 被网易风控了（换网络后重试，或先在网易网页端登录一次完成安全验证）',
  smtp_421: '发送太频繁或并发太多，被网易临时限制，等一会儿再试',
  smtp_timeout: '连接超时（网络慢或被挡住）',
  smtp_transport_error: '网络或加密层出错（连不上、TLS 握手失败等）',
  mail_unavailable: '发信配置不完整（缺少主机名或账号密码）',
  invalid_message: '邮箱地址或验证码格式不合法',
  invalid_host: 'SMTP 主机名不合法',
};

function translate(stage, reason) {
  const s = STAGE_TEXT[stage] || `未预期的阶段：${stage}`;
  const r = REASON_TEXT[reason] || '';
  return r ? `${s}\n     具体原因：${r}` : s;
}

function readLocalFile() {
  if (!fs.existsSync(LOCAL_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    if (!raw || typeof raw.user !== 'string' || typeof raw.pass !== 'string') return null;
    console.log(`（已读取 ${path.basename(LOCAL_FILE)}，跳过提问）\n`);
    return { user: raw.user, pass: raw.pass, to: typeof raw.to === 'string' ? raw.to : '' };
  } catch {
    console.log(`（${path.basename(LOCAL_FILE)} 读取失败或格式不对，改为手动输入）\n`);
    return null;
  }
}

async function main() {
  console.log('');
  console.log('==============================================');
  console.log('  SMTP 发信检查（163 邮箱）');
  console.log('==============================================');
  console.log('');
  console.log('本工具会真的发一封邮件出去，用来确认配置能否跑通。');
  console.log('邮件会发给下面第三个问题里填的地址，默认发给你自己。');
  console.log('');

  if (!mail._internals || typeof mail._internals.validEmail !== 'function') {
    console.log('✗ 程序文件不完整：找不到 platform/mail.js。');
    console.log('  请确认你是在项目根目录（能看到 server.js 的那一层）执行本工具。');
    process.exit(1);
  }
  const validEmail = mail._internals.validEmail;

  let answers = readLocalFile();
  let rl = null;
  if (!answers) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const user = (await rl.question('1. 你的完整 163 邮箱地址（例如 zhangsan@163.com）：')).trim();
    const pass = (await rl.question('2. 你复制保存的那 16 位授权码：')).trim();
    const toRaw = (await rl.question('3. 收件邮箱（直接按回车 = 发给你自己）：')).trim();
    answers = { user, pass, to: toRaw || user };
  }
  if (rl) rl.close();

  const { user, pass } = answers;
  const to = answers.to && answers.to.trim() ? answers.to.trim() : user;

  console.log('');
  if (!validEmail(user)) {
    console.log(`✗ 邮箱地址「${user}」看起来不对，请检查是不是写错了。`);
    process.exit(1);
  }
  if (!pass) {
    console.log('✗ 授权码不能为空。');
    process.exit(1);
  }
  if (!validEmail(to)) {
    console.log(`✗ 收件邮箱「${to}」看起来不对，请检查是不是写错了。`);
    process.exit(1);
  }

  const config = mail.loadConfig({
    NODE_ENV: '',
    SMTP_HOST: 'smtp.163.com',
    SMTP_SECURE: 'true',
    SMTP_PORT: '465',
    SMTP_USER: user,
    SMTP_PASS: pass,
  });

  console.log('即将检查：');
  console.log(`   发信账号：${user}`);
  console.log(`   收件地址：${to}`);
  console.log(`   服务器　：smtp.163.com:465（加密）`);
  console.log(`   授权码　：${'*'.repeat(Math.min(pass.length, 8))}（${pass.length} 位）`);
  console.log('');
  // 交互环境下等一次回车确认；非交互（脚本/管道）时直接继续
  if (process.stdin.isTTY) {
    console.log('按回车开始（会真的发一封邮件出去）：');
    const wait = readline.createInterface({ input: process.stdin, output: process.stdout });
    await wait.question('');
    wait.close();
  }

  console.log('');
  console.log('正在连接 smtp.163.com，通常几秒内完成，最多等 60 秒…');
  console.log('');

  const code = '135790';
  const started = Date.now();
  let result;
  try {
    result = await mail.sendVerification({
      to,
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      config,
    });
  } catch (e) {
    result = { outcome: 'failed', reason: 'unexpected_error', stage: 'connect', error: e };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log('----------------------------------------------');
  if (result.outcome === 'accepted') {
    console.log('✅ 成功！');
    console.log('');
    console.log(`   平台成功把邮件交给了网易的服务器（耗时 ${seconds} 秒）。`);
    console.log('');
    console.log(`   现在请打开邮箱 ${to} 查看：`);
    console.log('     · 主题：【Claw Clash】邮箱验证码');
    console.log(`     · 验证码：${code}（这是本次检查用的假验证码，不用管它）`);
    console.log('');
    console.log('   提醒：如果收件箱里没有，请翻一下「垃圾邮件」文件夹。');
    console.log('');
    console.log('   这一步通过，说明平台的上线配置可以直接用，不需要改代码。');
  } else {
    console.log('❌ 没有发出去。');
    console.log('');
    console.log(`   卡在哪一步：${translate(result.stage, result.reason)}`);
    console.log(`   服务器返回：${result.reason || '（无）'}`);
    console.log(`   耗时：${seconds} 秒`);
    if (result.outcome === 'unknown') {
      console.log('');
      console.log('   注意：邮件内容已经发出去了，但没等到服务器确认。');
      console.log('   有可能其实已经送到，先去邮箱和垃圾箱看一眼再判断。');
    }
    console.log('');
    console.log('   把上面这几行原样发给 Claude，它会告诉你怎么解决。');
  }
  console.log('----------------------------------------------');
  console.log('');
}

main().catch((e) => {
  console.log('');
  console.log('检查程序本身出错了：');
  console.log(e && e.stack ? e.stack : e);
  console.log('');
  process.exit(1);
});
