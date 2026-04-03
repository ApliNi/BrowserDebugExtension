const STORAGE_KEY = 'apliNiBrowserDebuggingExtensionToken';

const tokenInput = document.querySelector('#token-input');
const saveButton = document.querySelector('#save-button');
const regenButton = document.querySelector('#regen-button');
const statusNode = document.querySelector('#status');

function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (item) => item.toString(16).padStart(2, '0')).join('');
}

function getStoredToken() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STORAGE_KEY, (items) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      const token = typeof items?.[STORAGE_KEY] === 'string' ? items[STORAGE_KEY].trim() : '';
      resolve(token || '');
    });
  });
}

function setStoredToken(token) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: token }, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      resolve(true);
    });
  });
}

function setStatus(state, message) {
  statusNode.dataset.state = state || '';
  statusNode.textContent = message || '';
}

async function saveToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) {
    setStatus('error', 'Token 不能为空');
    tokenInput.focus();
    return;
  }

  await setStoredToken(token);
  tokenInput.value = token;
  setStatus('success', 'Token 已保存');
}

async function init() {
  let token = await getStoredToken();
  if (!token) {
    token = generateToken();
    await setStoredToken(token);
  }

  tokenInput.value = token;
  setStatus('', '');
}

saveButton.addEventListener('click', async () => {
  try {
    await saveToken(tokenInput.value);
  } catch (error) {
    setStatus('error', error.message || '保存失败');
  }
});

regenButton.addEventListener('click', async () => {
  const token = generateToken();
  tokenInput.value = token;

  try {
    await saveToken(token);
  } catch (error) {
    setStatus('error', error.message || '生成失败');
  }
});

tokenInput.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();

    try {
      await saveToken(tokenInput.value);
    } catch (error) {
      setStatus('error', error.message || '保存失败');
    }
  }
});

init().catch((error) => {
  setStatus('error', error.message || '初始化失败');
});
