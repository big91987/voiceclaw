// src/app/ui-settings.js — Settings Tab UI
import { getOpenClawPath, setOpenClawPath } from './api.js';

let onPathChangeCallback = null;

export function initSettingsTab(onPathChange) {
  onPathChangeCallback = onPathChange;

  document.getElementById('settings-path').value = getOpenClawPath();
  document.getElementById('btn-save-path').addEventListener('click', () => {
    const path = document.getElementById('settings-path').value.trim();
    setOpenClawPath(path);
    onPathChangeCallback?.(path);
  });
}

export function getCurrentPath() {
  return getOpenClawPath();
}
