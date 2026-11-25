'use strict';

window.Admin = window.Admin || {};

(function () {
  function applyDefaults() {
    if (!window.Chart) return;
    // Coral Glass (2026-11-25): warm muted ink, recessive grid, white tooltip.
    Chart.defaults.color = '#7a6a65';
    Chart.defaults.borderColor = 'rgba(120,72,58,0.1)';
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(255,255,255,0.97)';
    Chart.defaults.plugins.tooltip.borderColor = 'rgba(120,72,58,0.16)';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 12;
    Chart.defaults.plugins.tooltip.cornerRadius = 12;
    Chart.defaults.plugins.tooltip.titleColor = '#2b1d1a';
    Chart.defaults.plugins.tooltip.bodyColor = '#4a3a36';
    Chart.defaults.plugins.tooltip.usePointStyle = true;
    Chart.defaults.interaction = { mode: 'index', intersect: false };
    // Dates read flat and thin out instead of rotating into a pile.
    Chart.defaults.scale.ticks.maxRotation = 0;
    Chart.defaults.scale.ticks.autoSkipPadding = 12;
    Chart.defaults.elements.bar.borderRadius = 4;
    Chart.defaults.font.family = "'Inter', sans-serif";
  }

  // Coral Glass slots, checked for colour-blind separation on white. Old key names kept so pages need no change.
  const PALETTE = { teal: '#e0533a', red: '#c8283f', gold: '#d9a21b', info: '#0b6e70', warning: '#4a7fe0', purple: '#b8327a', gray: '#a8a09c' };

  function lineChart(ctx, { labels, datasets, yLabel }) {
    return new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: datasets.map((d) => ({
        tension: 0.3, pointRadius: 0, borderWidth: 2, fill: d.fill ?? false, ...d,
      })) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 10 } } },
        scales: {
          x: { grid: { display: false } },
          y: { title: { display: !!yLabel, text: yLabel }, grid: { color: 'rgba(120,72,58,0.08)' } },
        },
      },
    });
  }

  function barChart(ctx, { labels, datasets, stacked = false }) {
    return new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1, labels: { boxWidth: 10 } } },
        scales: {
          x: { stacked, grid: { display: false } },
          y: { stacked, grid: { color: 'rgba(120,72,58,0.08)' } },
        },
      },
    });
  }

  function horizontalBarChart(ctx, { labels, data, colors }) {
    return new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors || PALETTE.teal, borderRadius: 4 }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { color: 'rgba(120,72,58,0.08)' } }, y: { grid: { display: false } } },
      },
    });
  }

  function doughnutChart(ctx, { labels, data, colors }) {
    return new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors || Object.values(PALETTE) }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } } },
      },
    });
  }

  function sparkline(canvas, data, color = PALETTE.teal) {
    return new Chart(canvas, {
      type: 'line',
      data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
  }

  function gauge(canvas, value, max = 100, color = PALETTE.teal) {
    return new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [value, Math.max(0, max - value)],
          backgroundColor: [value / max > 0.85 ? PALETTE.red : color, 'rgba(120,72,58,0.08)'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        circumference: 180,
        rotation: 270,
        cutout: '75%',
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
  }

  Admin.Charts = { applyDefaults, lineChart, barChart, horizontalBarChart, doughnutChart, sparkline, gauge, PALETTE };
  document.addEventListener('DOMContentLoaded', applyDefaults);
})();
