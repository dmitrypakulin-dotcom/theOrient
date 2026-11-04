'use strict';

window.createModelTree = function ({ getModel, getSelection, selectPart, selectGroup, focus, visibilityChanged }) {
    const $ = (id) => document.getElementById(id);
    const menu = document.createElement('div');
    menu.className = 'part-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Действия в дереве модели');
    menu.style.position = 'fixed';
    document.body.append(menu);
    let contextNode = null;
    function closeMenu() {
        menu.hidden = true;
        contextNode = null;
    }
    function addMenuAction(label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('role', 'menuitem');
        button.onclick = () => {
            const node = contextNode;
            closeMenu();
            if (node) action(node);
        };
        menu.append(button);
    }
    addMenuAction('Скрыть невыделенное', (node) => {
        const model = getModel();
        if (!model) return;
        const selected = new Set(node.indices);
        model.panels.forEach((panel, index) => {
            panel.visible = selected.has(index);
        });
        visibilityChanged();
        choose(node);
    });
    addMenuAction('Приблизить', (node) => focusNode(node));
    document.addEventListener('pointerdown', (event) => {
        if (!menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) {
            const id = contextNode?.id;
            closeMenu();
            rows.get(id)?.select.focus();
        }
    });
    document.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    let currentModel = null,
        entries = new Map(),
        expanded = new Set(),
        rows = new Map(),
        previousSelection = null;
    let previousRowSelection,
        previousVisibility = null;
    const icon = (path) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
    const eyeIcon = icon('M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
    const hiddenIcon = icon(
        'm3 3 18 18M9 5.5A12 12 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3 4M6 6C3.5 8.5 2 12 2 12s3 7 10 7c1.5 0 3-.4 4-1 M10 10a3 3 0 0 0 4 4'
    );
    function setModel(model) {
        closeMenu();
        currentModel = model;
        entries = new Map();
        expanded = new Set();
        rows = new Map();
        previousSelection = null;
        function register(nodes, parent = null, depth = 0) {
            for (const node of nodes) {
                entries.set(node.id, { node, parent, depth });
                if (node.children.length && depth < 2) expanded.add(node.id);
                register(node.children, node.id, depth + 1);
            }
        }
        if (model) register(displayTree());
        rebuild();
    }
    function displayTree() {
        if (!currentModel) return [];
        function filter(nodes) {
            return nodes.flatMap((node) => {
                if ([3001, 4001, 4004].includes(node.type)) return [];
                const children = filter(node.children);
                const ownIndices = node.ownIndices.filter((index) => !currentModel.panels[index]?.userData.isHardware);
                const indices = ownIndices.concat(children.flatMap((child) => child.indices));
                return indices.length ? [{ ...node, children, ownIndices, indices }] : [];
            });
        }
        return filter(currentModel.tree || []);
    }
    function choose(node) {
        const model = getModel();
        if (!model) return;
        if (node.children.length || node.ownIndices.length !== 1) selectGroup(node);
        else selectPart(model.panels[node.ownIndices[0]]);
        sync();
    }
    function focusNode(node) {
        if (node) focus(node.indices);
    }
    function rebuild() {
        previousVisibility = null;
        const list = $('model-tree');
        list.replaceChildren();
        rows = new Map();
        function append(nodes, depth = 0) {
            const visible = nodes;
            visible.forEach((node, index) => {
                const row = document.createElement('div');
                row.className = 'model-tree-row';
                row.setAttribute('role', 'treeitem');
                row.dataset.nodeId = node.id;
                row.oncontextmenu = (event) => {
                    event.preventDefault();
                    choose(node);
                    contextNode = node;
                    menu.hidden = false;
                    menu.style.left =
                        Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4)) + 'px';
                    menu.style.top =
                        Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4)) + 'px';
                    menu.firstElementChild.focus();
                };
                row.setAttribute('aria-level', depth + 1);
                row.setAttribute('aria-posinset', index + 1);
                row.setAttribute('aria-setsize', visible.length);
                row.style.setProperty('--tree-depth', Math.min(depth, 8));
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'tree-expand';
                toggle.tabIndex = -1;
                const open = expanded.has(node.id);
                if (node.children.length) {
                    row.setAttribute('aria-expanded', Boolean(open));
                    toggle.innerHTML = icon(open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6');
                    toggle.setAttribute('aria-label', (open ? 'Свернуть ' : 'Развернуть ') + node.name);
                    toggle.onclick = () => {
                        if (expanded.has(node.id)) expanded.delete(node.id);
                        else expanded.add(node.id);
                        rebuild();
                        sync();
                    };
                } else {
                    toggle.disabled = true;
                    toggle.setAttribute('aria-hidden', 'true');
                }
                const select = document.createElement('button');
                select.type = 'button';
                select.className = 'tree-select';
                const glyph = document.createElement('span');
                glyph.className = 'tree-kind';
                glyph.innerHTML = icon(
                    node.children.length
                        ? 'M3 7V5h7l2 3h9v12H3V7Z'
                        : 'm5 4 14 3v14L5 18V4Z M5 4l4-2 14 3v14l-4 2 M19 7l4-2'
                );
                const text = document.createElement('span');
                text.className = 'tree-name';
                text.textContent = node.name;
                select.title = node.name;
                select.append(glyph, text);
                const positions = [
                    ...new Set(
                        node.ownIndices.map((index) => currentModel.panels[index]?.userData.artPos).filter(Boolean)
                    )
                ];
                if (positions.length) {
                    const position = document.createElement('small');
                    position.className = 'tree-position';
                    position.textContent = 'Поз. ' + positions.join(', ');
                    position.title = position.textContent;
                    position.style.flexShrink = '0';
                    position.style.whiteSpace = 'nowrap';
                    select.append(position);
                    select.title += ' - ' + position.textContent;
                }
                if (node.children.length) {
                    const count = document.createElement('small');
                    count.textContent = node.indices.length;
                    select.append(count);
                }
                select.onclick = () => choose(node);
                select.ondblclick = () => focusNode(node);
                select.onkeydown = (event) => {
                    if (event.key === 'ArrowRight' && node.children.length) {
                        event.preventDefault();
                        expanded.add(node.id);
                        rebuild();
                        rows.get(node.id)?.select.focus();
                    } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        if (expanded.has(node.id)) {
                            expanded.delete(node.id);
                            rebuild();
                            rows.get(node.id)?.select.focus();
                        } else rows.get(entries.get(node.id).parent)?.select.focus();
                    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault();
                        const items = [...rows.values()],
                            current = items.findIndex((item) => item.node.id === node.id);
                        const next =
                            event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? items.length - 1
                                  : current + (event.key === 'ArrowDown' ? 1 : -1);
                        items[Math.max(0, Math.min(items.length - 1, next))]?.select.focus();
                    }
                };
                const eye = document.createElement('button');
                eye.type = 'button';
                eye.className = 'tree-eye';
                eye.onclick = () => {
                    const model = getModel();
                    if (!model) return;
                    const show = !node.indices.every((index) => model.panels[index].visible);
                    for (const index of node.indices) model.panels[index].visible = show;
                    visibilityChanged();
                    sync();
                };
                row.append(toggle, select, eye);
                list.append(row);
                rows.set(node.id, { row, select, eye, node });
                if (node.children.length && open) append(node.children, depth + 1);
            });
        }
        append(displayTree());
        $('tree-empty').hidden = rows.size > 0;
        $('tree-empty').textContent = !currentModel
            ? 'Откройте модель, чтобы увидеть её структуру.'
            : 'Нет отображаемых деталей.';
        refreshRows();
    }
    function refreshRows() {
        const selection = getSelection(),
            model = getModel();
        const visibility = model ? model.panels.map((panel) => (panel.visible ? '1' : '0')).join('') : '';
        if (selection === previousRowSelection && visibility === previousVisibility) return;
        previousRowSelection = selection;
        previousVisibility = visibility;
        for (const { row, eye, node } of rows.values()) {
            row.classList.toggle('selected', selection === node.id);
            row.setAttribute('aria-selected', selection === node.id);
            const count = model ? node.indices.filter((index) => model.panels[index].visible).length : 0;
            const all = count === node.indices.length;
            row.classList.toggle('tree-hidden', !count);
            eye.classList.toggle('mixed', count > 0 && !all);
            const eyeState = count ? 'visible' : 'hidden';
            if (eye.dataset.state !== eyeState) {
                eye.innerHTML = count ? eyeIcon : hiddenIcon;
                eye.dataset.state = eyeState;
            }
            const label = (all ? 'Скрыть ' : 'Показать ') + node.name;
            eye.title = label;
            eye.setAttribute('aria-label', label);
            eye.setAttribute('aria-pressed', all);
        }
        $('tree-focus').disabled = !entries.has(selection);
        $('tree-show-all').disabled = !model || !model.panels.some((panel) => !panel.visible);
    }
    function sync() {
        if (currentModel !== getModel()) setModel(getModel());
        const selection = getSelection();
        if (selection && selection !== previousSelection && entries.has(selection)) {
            let parent = entries.get(selection).parent,
                changed = false;
            while (parent) {
                if (!expanded.has(parent)) {
                    expanded.add(parent);
                    changed = true;
                }
                parent = entries.get(parent).parent;
            }
            if (changed) rebuild();
            rows.get(selection)?.row.scrollIntoView({ block: 'nearest' });
        }
        previousSelection = selection;
        refreshRows();
    }
    $('tree-focus').onclick = () => focusNode(entries.get(getSelection())?.node);
    $('tree-show-all').onclick = () => {
        const model = getModel();
        if (!model) return;
        model.panels.forEach((panel) => {
            panel.visible = true;
        });
        visibilityChanged();
        sync();
    };
    setModel(null);
    return { setModel, sync };
};
