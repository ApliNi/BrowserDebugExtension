# BrowserDebugBridge

将浏览器调试能力暴露给网页.

> API 文档: [./src/doc.md](./src/doc.md)

这个项目用于简化自动化脚本的开发, 它将大量麻烦的常用功能封装成简单 API, 并将其暴露给页面和油猴脚本.

> 这个项目也能与 puppeteer 配合使用, 但它运行在页面和浏览器扩展 Service Worker 里, 而非外部, 所以没法在 nodejs 里直接调用它 :|



## 方案
这套方案足够满足许多自动化和爬虫需求, 完全隔离, 并且运行在浏览器内部.

### 浏览器
- [Google-Chrome-Portable](https://github.com/zzp198/Google-Chrome-Portable): 便携式 Chrome 浏览器, 实现隔离和多开

### 浏览器扩展
- [脚本猫](https://github.com/scriptscat/scriptcat): 管理和编写用户脚本
- [My Fingerprint](https://github.com/omegaee/my-fingerprint): 随机浏览器指纹
- [Zero Omega](https://github.com/zero-peak/ZeroOmega): 管理网页代理和路由
- 本扩展: 提供浏览器调试能力

### API
如果需要临时邮箱, 竟然我们已经在浏览器内做自动化了, 为什么不直接自动化操作一个临时邮箱网页呢.

我们可以轻松监听各种邮箱网页.
```js
if (location.host === 'mail.google.com' && location.pathname === '/mail/u/0/') {
	setInterval(() => {
		const text = document.querySelector('table > tbody > tr[tabindex]').innerText;
		const code = text.match(/验证码为：\s+([0-9-]+)\s+/)?.[1];
		if(code){
			GM_setValue('code', code);
		}
	}, 200);
}
```

```js
(async function() {
	let code = null;
	GM_addValueChangeListener('code', function() { code = arguments[2]; });
};
```


---

友链: https://linux.do/
