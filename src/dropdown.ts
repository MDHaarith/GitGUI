// Home-relative with the middle elided: /home/me/Documents/Projects/GitGUI → Documents/…/GitGUI
function shortPath(path: string) {
  const parts = path.replace(/^\/(home|Users)\/[^/]+\/?/, '').split('/').filter(Boolean);
  return parts.length > 2 ? parts[0] + '/…/' + parts[parts.length - 1] : parts.join('/') || '~';
}

export function wireDropdown(control: HTMLSelectElement, openRepository?: () => void) {
  const wrapper = document.createElement('div'); wrapper.className = 'select-control';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.id = control.id + '-button'; trigger.className = 'select-trigger';
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', control.getAttribute('aria-label') ?? control.labels?.[0]?.textContent ?? 'Scope');
  const value = document.createElement('span'); value.className = 'select-value';
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('class', 'chrome-icon select-chevron'); chevron.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#chrome-chevron'); chevron.append(use); trigger.append(value, chevron);
  const menu = document.createElement('div'); menu.id = control.id + '-menu'; menu.className = 'select-menu'; menu.popover = 'auto'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', trigger.getAttribute('aria-label')!);
  trigger.popoverTargetElement = menu; trigger.setAttribute('aria-controls', menu.id);
  control.before(wrapper); control.hidden = true; wrapper.append(control, trigger, menu);
  for (const label of control.labels ?? []) label.htmlFor = trigger.id;
  let items: HTMLElement[] = []; let active = -1; let restoreFocus = false;
  const isOpen = () => menu.matches(':popover-open');
  function activate(index: number) {
    if (!items.length) return;
    active = (index + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle('active', i === active));
    trigger.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }
  function close() { if (isOpen()) menu.hidePopover(); }
  function sync() {
    close();
    if (control.disabled && document.activeElement === trigger) restoreFocus = true;
    trigger.disabled = control.disabled; trigger.title = control.title;
    const reason = control.getAttribute('aria-description');
    if (reason) trigger.setAttribute('aria-description', reason); else trigger.removeAttribute('aria-description');
    value.replaceChildren(); menu.replaceChildren(); items = []; active = -1;
    const selected = control.selectedOptions[0];
    const name = document.createElement('span'); name.className = 'select-name';
    if (openRepository && selected?.value) { name.textContent = shortPath(selected.value); name.title = selected.value; } else name.textContent = selected?.textContent ?? 'Select';
    value.append(name);
    let previousGroup: HTMLElement | null = null;
    function appendItem(item: HTMLElement) {
      item.id = menu.id + '-option-' + items.length; item.classList.add('select-option'); item.setAttribute('role', 'option');
      item.addEventListener('pointermove', () => activate(items.indexOf(item))); items.push(item); menu.append(item);
    }
    for (const option of control.options) {
      if (option.disabled || (openRepository && !option.value && control.options.length > 1)) continue;
      const group = option.parentElement;
      if (group instanceof HTMLOptGroupElement && group !== previousGroup) { const heading = document.createElement('div'); heading.className = 'select-group'; heading.setAttribute('role', 'presentation'); heading.textContent = group.label; menu.append(heading); }
      previousGroup = group;
      const item = document.createElement('div'); item.dataset.value = option.value; item.setAttribute('aria-selected', String(option.selected));
      const check = document.createElement('span'); check.className = 'select-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true'); item.append(check);
      const label = document.createElement('span'); label.className = 'select-option-name'; label.textContent = openRepository && option.value ? option.value.split('/').filter(Boolean).pop() ?? option.value : option.textContent; item.append(label);
      if (option.dataset.current === 'true') { const badge = document.createElement('span'); badge.className = 'context-branch'; badge.textContent = 'Current'; item.append(badge); }
      if (openRepository && option.value) { const path = document.createElement('span'); path.className = 'select-option-path'; path.textContent = option.value; item.title = option.value; item.append(path); }
      item.addEventListener('click', () => { if (control.disabled) return; close(); trigger.focus(); control.value = option.value; control.dispatchEvent(new Event('change', { bubbles: true })); });
      appendItem(item);
    }
    if (openRepository) {
      const divider = document.createElement('div'); divider.className = 'select-divider'; divider.setAttribute('role', 'separator'); menu.append(divider);
      const item = document.createElement('div'); item.textContent = 'Open another repository…'; item.className = 'select-open'; item.setAttribute('aria-selected', 'false');
      item.addEventListener('click', () => { if (control.disabled) return; close(); trigger.focus(); openRepository(); }); appendItem(item);
    }
    if (restoreFocus && !trigger.disabled) { if (document.activeElement === document.body || document.activeElement === trigger) trigger.focus({ preventScroll: true }); restoreFocus = false; }
  }
  menu.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState !== 'open') return;
    const rect = trigger.getBoundingClientRect();
    menu.style.left = rect.left + 'px'; menu.style.top = rect.bottom + 6 + 'px';
    menu.style.maxHeight = Math.max(100, innerHeight - rect.bottom - 14) + 'px';
    active = Math.max(0, items.findIndex(item => item.getAttribute('aria-selected') === 'true'));
  });
  menu.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(isOpen()));
    if (isOpen()) { menu.style.left = Math.max(8, Math.min(trigger.getBoundingClientRect().left, innerWidth - menu.offsetWidth - 8)) + 'px'; activate(active); }
    else { trigger.removeAttribute('aria-activedescendant'); items.forEach(item => item.classList.remove('active')); }
  });
  trigger.addEventListener('keydown', event => {
    if (control.disabled) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const opening = !isOpen(); if (opening) menu.showPopover();
      activate(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : opening ? active : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (isOpen() && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); items[active]?.click(); }
    else if (isOpen() && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
  });
  sync(); return { sync };
}
