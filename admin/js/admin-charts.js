'use strict';

window.Admin = window.Admin || {};

(function () {
  function applyDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = '#6b7280';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
    Chart.defaults.font.family = "'Inter', sans-serif";
  }

  const PALETTE = { teal: '#00c896', red: '#ff4444', gold: '#ffd700', info: '#4fc3f7', warning: '#ff8c00', purple: '#a78bfa' };

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
          y: { title: { display: !!yLabel, text: yLabel }, grid: { color: 'rgba(255,255,255,0.04)' } },
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
          y: { stacked, grid: { color: 'rgba(255,255,255,0.04)' } },
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
        scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' } }, y: { grid: { display: false } } },
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
          backgroundColor: [value / max > 0.85 ? PALETTE.red : color, 'rgba(255,255,255,0.06)'],
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
