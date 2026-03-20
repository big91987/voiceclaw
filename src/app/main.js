// src/app/main.js — entry point, wires all modules together
import { connectEvents, on } from './api.js';

const dot = document.getElementById('status-dot');

connectEvents();
on('gateway-event', (e) => {
  if (e.type === 'connected') dot.className = 'dot dot--on';
});

console.log('main.js loaded');
