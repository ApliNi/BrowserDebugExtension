# BrowserDebugBridge

一个基于 Chrome Debugger 的浏览器扩展桥接工具。

它把扩展能力暴露给页面环境和 userscript，用一个可配置 token 作为桥接通道名，从而在页面里安全调用这些能力：

- 查找并点击元素
- 填充输入框
- 逐键输入
- 等待元素出现
- 等待 URL 匹配
- 等待网络空闲
- 读写扩展存储

项目内已包含一个 `test.user.js` 示例，演示如何从 userscript 通过桥接调用扩展能力完成自动化登录和页面操作。

## 特性

- 基于 `chrome.debugger`，不依赖页面自行暴露 API
- content script 与页面脚本双桥接
- token 可在扩展设置页中修改
- 默认自动生成 32 位随机字符串 token
- 支持普通 DOM 点击、输入、逐键输入、等待类操作
- 支持 `chrome.storage.local` / `chrome.storage.sync` 的字符串读写

## 安装扩展

1. 打开 Chrome 扩展管理页：`chrome://extensions/`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择本项目目录

## 设置 token

1. 打开扩展详情页
2. 进入“扩展选项”
3. 在设置页中查看或修改 `Bridge Token`
4. 保存后立即生效

说明：

- 默认会自动生成一个 32 位随机字符串
- token 实际保存在 `chrome.storage.local`
- 页面桥接会自动同步最新 token

## 桥接原理

页面环境中会注入：

```js
await window.ApliNiBrowserDebuggingExtension(token[, options])
```

其中：

- `ApliNiBrowserDebuggingExtension(token[, options])`：异步函数，只有在握手成功、确认已连接扩展后才会返回发送函数
- `token` 必填, 必须与扩展设置页中的 `Bridge Token` 完全一致
- `options.timeoutMs?: number`：初始化握手超时，默认 `3000`
- page-bridge 不再使用固定握手事件名
- 首次校验与正式通信都会直接使用 `token` 本身作为自定义事件名
- 只有知道正确 token 的可信脚本，才能与 `bridge.js` 建立隐蔽连接
- 初始化阶段如果出现任何问题，会直接抛错，不会返回不可用的 send 函数

最简调用：

```js
const send = await window.ApliNiBrowserDebuggingExtension('your-bridge-token');

const result = await send({ action: 'waitUrlMatch', pattern: /google\.com/ });

console.log(result);
```

userscript 示例：

```js
// ==UserScript==
// @name         autoext test loginGoogle
// @namespace    autoext
// @version      0.1.0
// @description  使用扩展 bridge 调用 loginGoogle 流程
// @match        *://*/*
// @grant        unsafeWindow
// ==/UserScript==

(async function () {
	'use strict';
	
	const BRIDGE_TOKEN = 'your-bridge-token';
	const debugSend = await unsafeWindow.ApliNiBrowserDebuggingExtension(BRIDGE_TOKEN);

	await debugSend({
		action: 'click',
		selector: 'button',
		selectorText: '下一步',
	});

})();
```

其中 `BRIDGE_TOKEN` 应当由可信脚本自行持有，并与扩展设置页中的值保持一致。

## 返回结果约定

成功时通常返回：

```js
{ ok: true, ...data }
```

失败时会抛出异常，错误文本通常包括：

- `Bridge access token is required`
- `Bridge access token mismatch`
- `Missing msg.action`
- `Missing msg.selector`
- `Missing msg.pattern`
- `Target is not editable`
- `waitUrlMatch timeout ...`
- `waitNetworkIdle timeout ...`

## 所有功能与示例

下面按 `action` 分类列出所有可调用能力。

---

### 1) `click`

点击目标元素。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `waitElement?: boolean` 默认 `true`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`
- `waitAfterFoundMs?: number` 默认 `100`

示例 1：点击按钮

```js
await send({
  action: 'click',
  selector: 'button',
  selectorText: '登录',
});
```

示例 2：多个选择器里找匹配文字的元素

```js
await send({
  action: 'click',
  selector: ['button', 'a'],
  selectorText: ['Continue with Google', 'Google 登录', '使用 Google 继续'],
  timeoutMs: 10000,
});
```

示例 3：不等待元素，立即执行

```js
await send({
  action: 'click',
  selector: '#submit',
  waitElement: false,
});
```

---

### 2) `input`

直接给输入框或可编辑节点赋值，并触发 `input` / `change` 事件。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `value?: string`
- `waitElement?: boolean`
- `intervalMs?: number`
- `timeoutMs?: number`
- `waitAfterFoundMs?: number`

示例 1：填写邮箱

```js
await send({
  action: 'input',
  selector: 'input[type="email"]',
  value: 'user@example.com',
});
```

示例 2：填写密码并延后执行

```js
await send({
  action: 'input',
  selector: 'input[type="password"]',
  value: 'secret-pass',
  waitAfterFoundMs: 2000,
});
```

示例 3：给 contenteditable 节点赋值

```js
await send({
  action: 'input',
  selector: '[contenteditable="true"]',
  value: 'hello world',
});
```

---

### 3) `inputKey`

先聚焦目标元素，再通过 debugger 模拟逐键输入，更接近真实键盘输入。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `value?: string`
- `waitElement?: boolean`
- `intervalMs?: number`
- `timeoutMs?: number`
- `waitAfterFoundMs?: number`
- `perKeyDelayMs?: number` 每个字符之间的延迟，默认 `0`

示例 1：逐键输入名称

```js
await send({
  action: 'inputKey',
  selector: '#name',
  value: 'test',
});
```

示例 2：模拟慢速打字

```js
await send({
  action: 'inputKey',
  selector: 'textarea',
  value: 'Hello from BrowserDebugBridge',
  perKeyDelayMs: 80,
});
```

示例 3：输入带换行的文本

```js
await send({
  action: 'inputKey',
  selector: 'textarea',
  value: 'line 1\nline 2',
});
```

---

### 4) `waitForElement`

等待元素出现，并可额外校验元素文本是否匹配。

参数：

- `selector: string | string[]` 必填
- `selectorText: string | string[]` 可选
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  attempts: 4,
  candidates: 2,
}
```

示例 1：等待一个输入框出现

```js
await send({
  action: 'waitForElement',
  selector: 'input[type="password"]',
});
```

示例 2：等待按钮且文本匹配

```js
await send({
  action: 'waitForElement',
  selector: 'button',
  selectorText: '下一步',
  timeoutMs: 15000,
});
```

示例 3：多个选择器联合等待

```js
await send({
  action: 'waitForElement',
  selector: ['button', 'a'],
  selectorText: ['Create', '创建'],
});
```

---

### 5) `waitUrlMatch`

轮询当前 tab URL，直到匹配指定正则。

参数：

- `pattern: string | RegExp` 必填
- `flags?: string`
- `intervalMs?: number` 默认 `200`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  attempts: 6,
  url: 'https://accounts.google.com/v3/signin/challenge/pwd?...'
}
```

示例 1：传入正则对象

```js
await send({
  action: 'waitUrlMatch',
  pattern: /\/v3\/signin\/challenge\/pwd\?.*/,
});
```

示例 2：传入字符串正则

```js
await send({
  action: 'waitUrlMatch',
  pattern: '.*\\/settings\\/keys$',
});
```

示例 3：附加 flags

```js
await send({
  action: 'waitUrlMatch',
  pattern: 'openrouter',
  flags: 'i',
});
```

---

### 6) `waitNetworkIdle`

等待页面网络请求进入空闲状态。

参数：

- `idleMs?: number` 默认 `1000`
- `timeoutMs?: number` 默认 `30000`

成功返回示例：

```js
{
  ok: true,
  tabId: 123,
  pending: 0,
  idleFor: 1187,
}
```

示例 1：等待默认空闲

```js
await send({
  action: 'waitNetworkIdle',
});
```

示例 2：要求至少 2 秒无网络活动

```js
await send({
  action: 'waitNetworkIdle',
  idleMs: 2000,
  timeoutMs: 60000,
});
```

典型用法：

```js
await send({ action: 'click', selector: 'button', selectorText: '提交' });
await send({ action: 'waitNetworkIdle', idleMs: 1500 });
```

---

### 7) `kvGet`

读取扩展存储中的字符串。

参数：

- `key: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

返回示例：

```js
{
  ok: true,
  area: 'local',
  key: 'apiKey',
  value: 'abc123'
}
```

示例：

```js
const res = await send({
  action: 'kvGet',
  key: 'apiKey',
  area: 'local',
});

console.log(res.value);
```

---

### 8) `kvSet`

写入扩展存储中的字符串。

参数：

- `key: string` 必填
- `value: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

示例 1：写入本地存储

```js
await send({
  action: 'kvSet',
  key: 'apiKey',
  value: 'abc123',
  area: 'local',
});
```

示例 2：写入同步存储

```js
await send({
  action: 'kvSet',
  key: 'profile',
  value: 'default',
  area: 'sync',
});
```

---

### 9) `kvDel`

删除扩展存储中的键。

参数：

- `key: string` 必填
- `area?: 'local' | 'sync'` 默认 `local`

示例：

```js
await send({
  action: 'kvDel',
  key: 'apiKey',
  area: 'local',
});
```

---

## 常见组合示例

### 示例 1：Google 登录流程

```js
await send({
  action: 'input',
  selector: 'input[type="email"]',
  value: 'user@example.com',
});

await send({
  action: 'click',
  selector: 'button',
  selectorText: '下一步',
});

await send({
  action: 'waitUrlMatch',
  pattern: /\/v3\/signin\/challenge\/pwd\?.*/,
});

await send({
  action: 'input',
  selector: 'input[type="password"]',
  value: 'secret-pass',
  waitAfterFoundMs: 2000,
});
```

### 示例 2：先确认元素已出现，再执行自定义逻辑

```js
const found = await send({
  action: 'waitForElement',
  selector: 'button',
  selectorText: 'Create',
});

console.log('按钮已出现，候选数:', found.candidates);

// 这里再决定是否继续执行别的动作
if (found.candidates > 0) {
  await send({ action: 'waitNetworkIdle', idleMs: 800 });
}
```

### 示例 3：点击后等待请求稳定

```js
await send({
  action: 'click',
  selector: '#submit',
});

await send({
  action: 'waitNetworkIdle',
  idleMs: 1500,
  timeoutMs: 30000,
});
```

### 示例 4：配置持久化

```js
await send({ action: 'kvSet', key: 'siteMode', value: 'prod' });

const config = await send({ action: 'kvGet', key: 'siteMode' });
console.log(config.value);

await send({ action: 'kvDel', key: 'siteMode' });
```

## 适用场景

- userscript 借助扩展能力执行受控自动化
- 登录流、按钮流、表单流自动化
- 等待页面稳定后继续执行下一步
- 用扩展存储为脚本保存少量字符串配置

---

友链: https://linux.do/
