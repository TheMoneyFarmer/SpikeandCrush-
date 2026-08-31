'use strict';

window.Admin = window.Admin || {};

// A small reusable client-side table controller: sorting, live search across
// given fields, per-column filters, pagination, optional row selection. Data
// is fetched once per page load (admin data volumes here are in the
// hundreds/low thousands of rows, not millions) and all of sort/search/page
// happens client-side against that array - simplest thing that works well at
// this scale, and every admin table in this panel uses it.
(function () {
  function createTable({ container, columns, rows, searchFields = [], pageSize = 25, rowKey = 'id', selectable = false, onRowClick = null }) {
    let state = { sortKey: null, sortDir: 1, search: '', page: 1, filters: {}, selected: new Set() };

    function filteredRows() {
      let out = rows;
      if (state.search) {
        const q = state.search.toLowerCase();
        out = out.filter((r) => searchFields.some((f) => String(r[f] ?? '').toLowerCase().includes(q)));
      }
      for (const [key, val] of Object.entries(state.filters)) {
        if (val === '' || val == null) continue;
        out = out.filter((r) => String(r[key]) === String(val));
      }
      if (state.sortKey) {
        out = [...out].sort((a, b) => {
          const av = a[state.sortKey], bv = b[state.sortKey];
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.sortDir;
          return String(av).localeCompare(String(bv)) * state.sortDir;
        });
      }
      return out;
    }

    function render() {
      const all = filteredRows();
      const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
      state.page = Math.min(state.page, totalPages);
      const pageRows = all.slice((state.page - 1) * pageSize, state.page * pageSize);

      const theadCells = columns.map((c) => {
        const sortedClass = state.sortKey === c.key ? `sorted ${state.sortDir === 1 ? 'asc' : ''}` : '';
        return `<th data-key="${c.key}" class="${sortedClass}">${c.label}</th>`;
      }).join('');

      const bodyRows = pageRows.map((row) => {
        const cells = columns.map((c) => `<td>${c.render ? c.render(row) : Admin.escapeHtml(row[c.key])}</td>`).join('');
        const checkCell = selectable ? `<td><input type="checkbox" class="row-checkbox" data-id="${row[rowKey]}" ${state.selected.has(String(row[rowKey])) ? 'checked' : ''}/></td>` : '';
        return `<tr class="${onRowClick ? 'clickable' : ''}" data-id="${row[rowKey]}">${checkCell}${cells}</tr>`;
      }).join('') || `<tr><td colspan="${columns.length + (selectable ? 1 : 0)}"><div class="empty-state">No rows match.</div></td></tr>`;

      container.innerHTML = `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr>${selectable ? `<th><input type="checkbox" id="tblSelectAll"/></th>` : ''}${theadCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
        <div class="admin-table-footer">
          <span>${all.length} row${all.length === 1 ? '' : 's'}${state.search ? ` (filtered)` : ''}</span>
          <div class="pagination-btns">
            <button class="btn btn-sm" id="tblPrev" ${state.page <= 1 ? 'disabled' : ''}>Prev</button>
            <span style="align-self:center;">Page ${state.page} / ${totalPages}</span>
            <button class="btn btn-sm" id="tblNext" ${state.page >= totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      `;

      container.querySelectorAll('thead th[data-key]').forEach((th) => {
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          if (state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = 1; }
          render();
        });
      });
      container.querySelector('#tblPrev')?.addEventListener('click', () => { state.page--; render(); });
      container.querySelector('#tblNext')?.addEventListener('click', () => { state.page++; render(); });

      if (onRowClick) {
        container.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
          tr.addEventListener('click', (e) => {
            if (e.target.classList.contains('row-checkbox')) return;
            const row = rows.find((r) => String(r[rowKey]) === tr.dataset.id);
            if (row) onRowClick(row);
          });
        });
      }

      if (selectable) {
        container.querySelectorAll('.row-checkbox').forEach((cb) => {
          cb.addEventListener('change', () => {
            if (cb.checked) state.selected.add(cb.dataset.id); else state.selected.delete(cb.dataset.id);
            table.onSelectionChange?.(Array.from(state.selected));
          });
        });
        const selectAll = container.querySelector('#tblSelectAll');
        if (selectAll) {
          selectAll.addEventListener('change', () => {
            pageRows.forEach((r) => {
              if (selectAll.checked) state.selected.add(String(r[rowKey])); else state.selected.delete(String(r[rowKey]));
            });
            render();
            table.onSelectionChange?.(Array.from(state.selected));
          });
        }
      }
    }

    const table = {
      render,
      setSearch: (q) => { state.search = q; state.page = 1; render(); },
      setFilter: (key, val) => { state.filters[key] = val; state.page = 1; render(); },
      setRows: (newRows) => { rows = newRows; render(); },
      getFiltered: filteredRows,
      getSelected: () => Array.from(state.selected),
      clearSelection: () => { state.selected.clear(); render(); },
      onSelectionChange: null,
    };
    render();
    return table;
  }

  Admin.createTable = createTable;
})();
