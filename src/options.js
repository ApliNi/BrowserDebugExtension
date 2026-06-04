const STORAGE_KEY = 'apliNiBrowserDebuggingExtensionToken';
const STARTUP_URL_STORAGE_KEY = 'apliNiBrowserDebuggingExtensionStartupUrl';

const tokenInput = document.querySelector('#token-input');
const startupUrlInput = document.querySelector('#startup-url-input');
const saveTokenButton = document.querySelector('#save-token-button');
const saveStartupUrlButton = document.querySelector('#save-startup-url-button');
const regenButton = document.querySelector('#regen-button');
const tokenStatusNode = document.querySelector('#token-status');
const startupUrlStatusNode = document.querySelector('#startup-url-status');
const startupUrlPanel = document.querySelector('#startup-url-panel');

function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (item) => item.toString(16).padStart(2, '0')).join('');
}

function normalizeStartupUrl(rawUrl) {
  const urlText = String(rawUrl || '').trim();
  if (!urlText) return '';

  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch (error) {
    throw new Error(`启动打开 URL 无效：${error.message || String(error)}`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('启动打开 URL 仅支持 http:// 或 https://');
  }

  return parsedUrl.href;
}

function normalizeStartupUrls(rawUrls) {
  return String(rawUrls || '')
    .split(/\r?\n/)
    .map((rawUrl, index) => {
      try {
        return normalizeStartupUrl(rawUrl);
      } catch (error) {
        throw new Error(`第 ${index + 1} 行${error.message || '启动打开 URL 无效'}`);
      }
    })
    .filter(Boolean)
    .join('\n');
}

function getStoredOptions() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY, STARTUP_URL_STORAGE_KEY], (items) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      const token = typeof items?.[STORAGE_KEY] === 'string' ? items[STORAGE_KEY].trim() : '';
      const startupUrl = typeof items?.[STARTUP_URL_STORAGE_KEY] === 'string' ? items[STARTUP_URL_STORAGE_KEY].trim() : '';
      resolve({ token: token || '', startupUrl });
    });
  });
}

function setStoredToken(token) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({
      [STORAGE_KEY]: token,
    }, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(true);
    });
  });
}

function setStoredStartupUrl(startupUrl) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({
      [STARTUP_URL_STORAGE_KEY]: startupUrl,
    }, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(true);
    });
  });
}

function setStatus(statusNode, state, message) {
  statusNode.dataset.state = state || '';
  statusNode.textContent = message || '';
}

async function saveToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) {
    setStatus(tokenStatusNode, 'error', 'Token 不能为空');
    tokenInput.focus();
    return;
  }

  await setStoredToken(token);
  tokenInput.value = token;
  setStatus(tokenStatusNode, 'success', 'Token 已保存');
}

async function saveStartupUrl(rawStartupUrl) {
  let startupUrl;
  try {
    startupUrl = normalizeStartupUrls(rawStartupUrl);
  } catch (error) {
    setStatus(startupUrlStatusNode, 'error', error.message || '启动打开 URL 无效');
    startupUrlInput.focus();
    return;
  }

  await setStoredStartupUrl(startupUrl);
  startupUrlInput.value = startupUrl;
  setStatus(startupUrlStatusNode, 'success', '启动 URL 已保存');
}

async function init() {
  const options = await getStoredOptions();
  let token = options.token;
  if (!token) {
    token = generateToken();
    await setStoredToken(token);
  }

  tokenInput.value = token;
  startupUrlInput.value = options.startupUrl;
  setStatus(tokenStatusNode, '', '');
  setStatus(startupUrlStatusNode, '', '');
}

saveTokenButton.addEventListener('click', async () => {
  try {
    await saveToken(tokenInput.value);
  } catch (error) {
    setStatus(tokenStatusNode, 'error', error.message || '保存 Token 失败');
  }
});

saveStartupUrlButton.addEventListener('click', async () => {
  try {
    await saveStartupUrl(startupUrlInput.value);
  } catch (error) {
    setStatus(startupUrlStatusNode, 'error', error.message || '保存启动 URL 失败');
  }
});

regenButton.addEventListener('click', async () => {
  const token = generateToken();
  tokenInput.value = token;

  try {
    await setStoredToken(token);
    setStatus(tokenStatusNode, 'success', 'Token 已重新生成并保存');
  } catch (error) {
    setStatus(tokenStatusNode, 'error', error.message || '生成 Token 失败');
  }
});

document.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();

    try {
      if (startupUrlPanel.contains(document.activeElement)) {
        await saveStartupUrl(startupUrlInput.value);
      } else {
        await saveToken(tokenInput.value);
      }
    } catch (error) {
      const statusNode = startupUrlPanel.contains(document.activeElement) ? startupUrlStatusNode : tokenStatusNode;
      setStatus(statusNode, 'error', error.message || '保存失败');
    }
  }
});

init().catch((error) => {
  setStatus(tokenStatusNode, 'error', error.message || '初始化失败');
});
