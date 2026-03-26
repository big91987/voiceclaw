// src/app/ui-settings.js — Settings Tab UI
import { getOpenClawPath, setOpenClawPath } from './api.js';
import { getSetting, setSetting } from './settings.js';

let onPathChangeCallback = null;

export function initSettingsTab(onPathChange) {
  onPathChangeCallback = onPathChange;

  document.getElementById('settings-path').value = getOpenClawPath();
  document.getElementById('btn-save-path').addEventListener('click', () => {
    const path = document.getElementById('settings-path').value.trim();
    setOpenClawPath(path);
    onPathChangeCallback?.(path);
  });

  // Initialize and wire showThinking toggle
  const showThinkingEl = document.getElementById('setting-show-thinking');
  showThinkingEl.checked = getSetting('showThinking');
  showThinkingEl.addEventListener('change', () => setSetting('showThinking', showThinkingEl.checked));

  // Initialize and wire showToolCalls toggle
  const showToolCallsEl = document.getElementById('setting-show-tool-calls');
  showToolCallsEl.checked = getSetting('showToolCalls');
  showToolCallsEl.addEventListener('change', () => setSetting('showToolCalls', showToolCallsEl.checked));

  // Initialize and wire callQueueMode select
  const callQueueModeEl = document.getElementById('setting-call-queue-mode');
  callQueueModeEl.value = getSetting('callQueueMode');
  callQueueModeEl.addEventListener('change', () => setSetting('callQueueMode', callQueueModeEl.value));

  // Initialize and wire injectPara toggle
  const injectParaEl = document.getElementById('setting-inject-para');
  injectParaEl.checked = getSetting('injectPara');
  injectParaEl.addEventListener('change', () => setSetting('injectPara', injectParaEl.checked));
}

export function getCurrentPath() {
  return getOpenClawPath();
}
