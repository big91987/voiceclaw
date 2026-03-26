// src/app/settings.js — lightweight config center (localStorage)
const DEFAULTS = {
  showThinking: true,
  showToolCalls: true,
  callQueueMode: 'interrupt',
  injectPara: true,
};

const PREFIX = 'vc_setting_';

export function getSetting(key) {
  const raw = localStorage.getItem(PREFIX + key);
  if (raw === null) return DEFAULTS[key];
  try { return JSON.parse(raw); } catch { return DEFAULTS[key]; }
}

export function setSetting(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}
