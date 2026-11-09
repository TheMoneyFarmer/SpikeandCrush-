'use strict';

// Shared form behaviour: one request per action, a loading button, errors under
// each field, a summary that takes focus, and friendly messages. Values typed by
// the player are never cleared here.
(function () {
  const CONNECTION = 'Connection problem. Try again.';

  function friendly(err) {
    if (!err) return 'Something went wrong. Try again.';
    if (err.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(err.message || '')) return CONNECTION;
    if (err.error && typeof err.error === 'object' && err.error.message) return err.error.message;
    const text = String(err.message || err.error || '').trim();
    if (!text || text.length > 200 || /\bat .+:\d+|stack|sql|postgres|undefined|\bnull\b/i.test(text)) return 'Something went wrong. Try again.';
    return text;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
      button.textContent = label || button.dataset.idleLabel;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.classList.add('is-loading');
    } else {
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.remove('is-loading');
    }
  }

  function clearErrors(form) {
    form.querySelectorAll('[data-field-error]').forEach((el) => el.remove());
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    });
    const summary = form.querySelector('[data-error-summary]');
    if (summary) { summary.textContent = ''; summary.hidden = true; }
  }

  function fieldError(input, message) {
    input.setAttribute('aria-invalid', 'true');
    const id = `${input.id || input.name}-error`;
    const note = document.createElement('p');
    note.id = id;
    note.dataset.fieldError = '';
    note.className = 'field-error';
    note.textContent = message;
    input.setAttribute('aria-describedby', id);
    input.insertAdjacentElement('afterend', note);
  }

  function showSummary(form, message) {
    let summary = form.querySelector('[data-error-summary]');
    if (!summary) {
      summary = document.createElement('div');
      summary.dataset.errorSummary = '';
      summary.className = 'error-summary';
      summary.setAttribute('role', 'alert');
      summary.tabIndex = -1;
      form.prepend(summary);
    }
    summary.textContent = message;
    summary.hidden = false;
    summary.focus();
  }

  function messageFor(input) {
    const v = input.validity;
    const label = input.dataset.label || 'This field';
    if (v.valueMissing) return input.type === 'checkbox' ? input.dataset.requiredMessage || 'Please tick this box to continue.' : `${label} is required.`;
    if (v.typeMismatch && input.type === 'email') return 'Enter a valid email address.';
    if (v.tooShort) return `${label} must be at least ${input.minLength} characters.`;
    if (v.tooLong) return `${label} must be at most ${input.maxLength} characters.`;
    if (v.patternMismatch) return input.dataset.patternMessage || `${label} isn't in the right format.`;
    return input.validationMessage || `${label} isn't valid.`;
  }

  // True if the form is fine. Otherwise marks each field and focuses the summary.
  function validate(form) {
    clearErrors(form);
    const bad = [...form.querySelectorAll('input, select, textarea')].filter((el) => el.willValidate && !el.checkValidity());
    bad.forEach((el) => fieldError(el, messageFor(el)));
    if (bad.length) showSummary(form, bad.length === 1 ? 'Please fix the field below.' : `Please fix the ${bad.length} fields below.`);
    return bad.length === 0;
  }

  // Runs `action` at most once at a time. Failures show in the summary and the
  // button comes back, so trying again is one click.
  function handle(form, button, busyLabel, action) {
    let running = false;
    form.noValidate = true;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (running) return;
      if (!validate(form)) return;
      running = true;
      setBusy(button, true, busyLabel);
      try {
        const keepBusy = await action();
        if (keepBusy === true) return;
      } catch (err) {
        showSummary(form, friendly(err));
      }
      running = false;
      setBusy(button, false);
    });
  }

  window.SCForm = { friendly, setBusy, clearErrors, fieldError, showSummary, validate, handle };
})();
