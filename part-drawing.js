(function (root) {
    'use strict';

    // ==========================================
    // 1. ИЗВЛЕЧЕНИЕ ДАННЫХ О ДЕТАЛИ И ОТВЕРСТИЯХ
    // ==========================================

    /**
     * Подготавливает данные для чертежа: геометрию в локальных координатах детали, 
     * её габариты и список отверстий (сверловок), которые в неё попадают.
     */
    function data(part, model, THREE) {
        // Получаем обратную матрицу, чтобы перевести мировые координаты в локальные координаты детали
        const inverse = part.userData.localMatrix.clone().invert();
        const geometry = part.geometry.clone().applyMatrix4(inverse);
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox.clone(),
            holes = [],
            seen = new Set();

        // Ищем все сверловки (отверстия) из модели, которые попадают в габариты этой детали
        for (const drilling of model.drillings || []) {
            const start = drilling.start.clone().applyMatrix4(inverse),
                direction = drilling.direction.clone().transformDirection(inverse);
            let near = 0,
                far = drilling.depth,
                valid = true;

            // Проверяем, пересекает ли луч отверстия габаритный ящик детали (AABB)
            for (const axis of ['x', 'y', 'z']) {
                if (Math.abs(direction[axis]) < 1e-7) {
                    if (start[axis] < bounds.min[axis] - 0.01 || start[axis] > bounds.max[axis] + 0.01) valid = false;
                } else {
                    const a = (bounds.min[axis] - start[axis]) / direction[axis],
                        b = (bounds.max[axis] - start[axis]) / direction[axis];
                    near = Math.max(near, Math.min(a, b));
                    far = Math.min(far, Math.max(a, b));
                }
            }
            if (!valid || far - near < 0.01) continue;

            const center = start.clone().addScaledVector(direction, near),
                depth = far - near;

            // Уникальный ключ, чтобы не добавлять одно и то же отверстие дважды
            const key = [...center.toArray(), ...direction.toArray(), drilling.radius, depth]
                .map((n) => n.toFixed(3))
                .join(':');
            if (seen.has(key)) continue;
            seen.add(key);

            holes.push({ center, direction, diameter: drilling.radius * 2, depth, name: drilling.name });
        }
        return { geometry, bounds, holes };
    }

    // ==========================================
    // 2. ОТКРЫТИЕ ОКНА С ЧЕРТЕЖОМ
    // ==========================================

    function open(part, model) {
        const THREE = root.THREE,
            result = data(part, model, THREE),
            { bounds, holes, geometry } = result;

        // Удаляем старый чертёж, если он открыт
        const old = document.getElementById('part-drawing');
        if (old) old.close();

        const dialog = document.createElement('dialog');
        dialog.id = 'part-drawing';
        dialog.className = 'part-drawing';

        const heading = document.createElement('h2');
        heading.textContent = part.name + (part.userData.artPos ? ' · Поз. ' + part.userData.artPos : '');

        const actions = document.createElement('div');
        actions.className = 'drawing-actions';
        const close = document.createElement('button');
        close.textContent = 'Закрыть';
        close.onclick = () => dialog.close();
        actions.append(close);

        // Базовые настройки SVG
        const ns = 'http://www.w3.org/2000/svg',
            svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 1400 1000');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Чертёж детали, три проекции');

        let activeLayer = null,
            activeFitting = null,
            targetGroup = svg;

        // Утилита для создания SVG-элементов
        function element(tag, attrs, text) {
            const node = document.createElementNS(ns, tag);
            for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
            if (attrs.stroke) node.setAttribute('vector-effect', 'non-scaling-stroke');
            if (activeLayer) node.dataset.drawingLayer = activeLayer;
            if (activeFitting) node.dataset.fitting = activeFitting;
            if (text !== undefined) node.textContent = text;
            targetGroup.append(node);
            return node;
        }

        const fmt = (n) => Math.round(n).toString(),
            size = bounds.getSize(new THREE.Vector3());

        // Фон чертежа и заголовки
        element('rect', { width: 1400, height: 1000, fill: 'white' });
        element('text', { x: 30, y: 30, 'font-size': 18, fill: '#243746' }, part.name);
        element('text', { x: 30, y: 55, 'font-size': 13, fill: '#708295' }, 'Размеры в мм');

        const movableLabels = [],
            projections = [],
            overallDimensions = [];

        // Утилита для создания текстовых подписей с белой обводкой (чтобы читалось поверх линий)
        const label = (x, y, text, attrs = {}) =>
            element(
                'text',
                {
                    x, y,
                    'font-size': 12,
                    fill: '#354d63',
                    'paint-order': 'stroke',
                    stroke: 'white',
                    'stroke-width': 4,
                    'stroke-linejoin': 'round',
                    ...attrs
                },
                text
            );

        function annotation(x, y, text, vertical = false, color = '#354d63') {
            const node = label(x, y, text, { 'font-size': 12, 'text-anchor': 'middle', fill: color });
            movableLabels.push({ node, preferred: { x, y }, vertical, projection: targetGroup });
            return node;
        }

        // ==========================================
        // 3. УМНОЕ РАЗМЕЩЕНИЕ ПОДПИСЕЙ (ЧТОБЫ НЕ ПЕРЕКРЫВАЛИСЬ)
        // ==========================================

        /**
         * Алгоритм, который двигает подписи, чтобы они не наезжали друг на друга.
         * Сложная математика для поиска свободного места.
         */
        function arrangeLabels() {
            const occupied = new Map();
            for (const item of movableLabels) {
                const font = Number(item.node.getAttribute('font-size'));
                const p = { ...item.preferred };
                if (item.node.dataset.coordinate) continue;
                item.node.setAttribute('x', p.x);
                item.node.setAttribute('y', p.y + font * 0.3);
                if (item.vertical) item.node.setAttribute('transform', `rotate(-90 ${p.x} ${p.y})`);
            }

            for (const projection of projections) {
                const boxes = [];
                occupied.set(projection.group, boxes);
                
                // Расставляем подписи отверстий (в верхней части)
                const captions = movableLabels.filter(
                    (item) => item.projection === projection.group && item.node.dataset.holeCaption
                );
                const bandWidth = Math.max(260, projection.width);
                let captionX = projection.left,
                    captionRow = 0;
                const rowHeight = Math.max(
                    24,
                    ...captions.map((item) => Number(item.node.getAttribute('font-size')) * 1.8 + 8)
                );
                for (const item of captions) {
                    const font = Number(item.node.getAttribute('font-size')),
                        width = item.node.getComputedTextLength() + 22;
                    if (captionX > projection.left && captionX + width > projection.left + bandWidth) {
                        captionX = projection.left;
                        captionRow++;
                    }
                    item.node.setAttribute('x', captionX + width / 2);
                    item.node.setAttribute('y', projection.top - 42 - captionRow * rowHeight);
                    item.node.removeAttribute('transform');
                    captionX += width;
                }

                // Расставляем размеры по осям X (снизу) и Y (слева)
                for (const side of ['bottom', 'left']) {
                    const items = movableLabels
                        .filter(
                            (item) => item.projection === projection.group && item.node.dataset.coordinateSide === side
                        )
                        .sort(
                            (a, b) =>
                                Number(a.node.dataset[side === 'bottom' ? 'anchorX' : 'anchorY']) -
                                Number(b.node.dataset[side === 'bottom' ? 'anchorX' : 'anchorY'])
                        );
                    const anchors = items.map((item) =>
                        Number(item.node.dataset[side === 'bottom' ? 'anchorX' : 'anchorY'])
                    );
                    const slots = [];
                    let previous = -Infinity;
                    
                    // Раздвигаем подписи, если они слишком близко
                    items.forEach((item, i) => {
                        const gap = Number(item.node.getAttribute('font-size')) * 1.5 + 5;
                        const slot = Math.max(anchors[i], previous + gap);
                        slots.push(slot);
                        previous = slot;
                    });
                    
                    const shift = slots.length
                        ? slots.reduce((sum, v, i) => sum + v - anchors[i], 0) / slots.length
                        : 0;
                        
                    items.forEach((item, i) => {
                        const font = Number(item.node.getAttribute('font-size')),
                            length = item.node.getComputedTextLength() + 8,
                            slot = slots[i] - shift;
                        const px = side === 'bottom' ? slot : projection.left - 42 - length / 2;
                        const py = side === 'bottom' ? projection.bottom + 26 + length / 2 : slot;
                        item.node.setAttribute('x', px);
                        item.node.setAttribute('y', py + font * 0.3);
                        if (side === 'bottom') item.node.setAttribute('transform', `rotate(-90 ${px} ${py})`);
                        else item.node.removeAttribute('transform');
                        
                        const width = side === 'bottom' ? font * 1.6 : length,
                            height = side === 'bottom' ? length : font * 1.6;
                        boxes.push({ x: px - width / 2, y: py - height / 2, width, height });
                        
                        const ax = Number(item.node.dataset.anchorX),
                            ay = Number(item.node.dataset.anchorY);
                        item.guide.setAttribute(
                            'd',
                            side === 'bottom'
                                ? `M${ax},${ay}V${projection.bottom + 8}L${slot},${projection.bottom + 20}`
                                : `M${ax},${ay}H${projection.left - 8}L${projection.left - 20},${slot}`
                        );
                    });
                }
            }
            
            // Расстановка габаритных размеров (самых крайних)
            for (const dimension of overallDimensions) {
                const { node, vertical, tx, ty, min, max, projection } = dimension;
                const font = Number(node.getAttribute('font-size')),
                    length = node.getComputedTextLength();
                const half = length / 2 + 7,
                    low = min + half,
                    high = max - half;
                const center = (min + max) / 2,
                    segments = [];
                    
                for (const guide of projection.querySelectorAll('[data-coordinate-guide]')) {
                    const total = guide.getTotalLength();
                    let previous = guide.getPointAtLength(0);
                    for (let distance = 5; distance < total + 5; distance += 5) {
                        const point = guide.getPointAtLength(Math.min(distance, total));
                        segments.push([previous, point]);
                        previous = point;
                    }
                }
                
                // Проверка пересечения текста с линиями
                function intersects(a, b, box) {
                    let near = 0, far = 1;
                    for (const axis of ['x', 'y']) {
                        const delta = b[axis] - a[axis],
                            min = box[axis],
                            max = min + box[axis === 'x' ? 'width' : 'height'];
                        if (Math.abs(delta) < 1e-8) {
                            if (a[axis] < min || a[axis] > max) return false;
                        } else {
                            const p = (min - a[axis]) / delta,
                                q = (max - a[axis]) / delta;
                            near = Math.max(near, Math.min(p, q));
                            far = Math.min(far, Math.max(p, q));
                        }
                    }
                    return far >= near;
                }
                
                let best = center,
                    bestScore = Infinity;
                const candidates = [center];
                for (let step = 6; step < max - min; step += 6) candidates.push(center - step, center + step);
                
                for (const position of candidates) {
                    if (low <= high && (position < low || position > high)) continue;
                    if (low > high && position !== center) continue;
                    const box = vertical
                        ? { x: tx - font - 5, y: position - half, width: font + 10, height: half * 2 }
                        : { x: position - half, y: ty - font - 5, width: half * 2, height: font + 10 };
                    const score = segments.reduce((sum, [a, b]) => sum + Number(intersects(a, b, box)), 0);
                    if (score < bestScore) {
                        bestScore = score;
                        best = position;
                    }
                    if (!score) break;
                }
                const x = vertical ? tx : best,
                    y = vertical ? best : ty;
                node.setAttribute('x', x);
                node.setAttribute('y', y);
                if (vertical) node.setAttribute('transform', `rotate(-90 ${x} ${y})`);
            }
        }

        /**
         * Отрисовка конкретного линейного размера (с засечками и текстом).
         */
        function dimension(x1, y1, x2, y2, text, vertical = false) {
            const tick = 4;
            element('path', {
                d: `M${x1},${y1}L${x2},${y2}M${x1 - tick},${y1 + tick}l${tick * 2},${-tick * 2}M${x2 - tick},${y2 + tick}l${tick * 2},${-tick * 2}`,
                stroke: '#718394',
                'stroke-width': 0.8,
                fill: 'none'
            });
            const tx = (x1 + x2) / 2 - (vertical ? 8 : 0),
                ty = (y1 + y2) / 2 - (vertical ? 0 : 7);
            const node = label(tx, ty, text, {
                'text-anchor': 'middle',
                ...(vertical ? { transform: `rotate(-90 ${tx} ${ty})` } : {})
            });
            overallDimensions.push({
                node, vertical, tx, ty,
                min: vertical ? Math.min(y1, y2) : Math.min(x1, x2),
                max: vertical ? Math.max(y1, y2) : Math.max(x1, x2),
                projection: targetGroup.parentNode
            });
        }

        // ==========================================
        // 4. ГЕНЕРАЦИЯ ПРОЕКЦИЙ (ПЛАСТЬ И ТОРЦЫ)
        // ==========================================

        const inverse = part.userData.localMatrix.clone().invert(),
            fittings = [];

        // Ищем фурнитуру (крепёж), которая попадает в габариты детали
        for (const object of model.hardware.children) {
            const positions = object.geometry?.attributes.position;
            if (!positions) continue;
            const points = Array.from({ length: positions.count }, (_, i) =>
                new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(inverse)
            );
            if (new THREE.Box3().setFromPoints(points).intersectsBox(bounds.clone().expandByScalar(0.3)))
                fittings.push({ points, name: object.name || 'Крепёж' });
        }

        const edges = new THREE.EdgesGeometry(geometry, 25),
            positions = edges.attributes.position;

        // Настройки для трех видов: [ось X, ось Y, нормаль Z, отступ слева, отступ сверху, заголовок]
        const views = [
            ['x', 'y', 'z', 90, 130, 'Пласть · X / Y'],
            ['x', 'z', 'y', 90, 130, 'Торец · X / Z'],
            ['z', 'y', 'x', 90, 130, 'Торец · Z / Y']
        ];

        // Вычисляем масштаб, чтобы деталь влезла в отведенное место на экране
        const projectionScale = Math.min(
            470 / Math.max(size.x, 0.01),
            360 / Math.max(size.y, 0.01),
            230 / Math.max(size.z, 0.01)
        );

        for (const [a, b, normal, left, top, title] of views) {
            const projectionGroup = document.createElementNS(ns, 'g');
            svg.append(projectionGroup);
            targetGroup = projectionGroup;

            const scale = projectionScale,
                width = size[a] * scale,
                height = size[b] * scale;
                
            const x = (p) => left + (p[a] - bounds.min[a]) * scale,
                y = (p) => top + height - (p[b] - bounds.min[b]) * scale;

            element('text', { x: left, y: top - 15, 'font-size': 14 }, title);

            const vertices = geometry.attributes.position,
                index = geometry.index;

            // Отрисовка заливки (полупрозрачный серый цвет детали)
            const surface = document.createElementNS(ns, 'g');
            surface.setAttribute('opacity', '.12');
            targetGroup.append(surface);
            let fillPath = '';
            for (let i = 0, count = index ? index.count : vertices.count; i < count; i += 3) {
                const triangle = [0, 1, 2].map((j) =>
                    new THREE.Vector3().fromBufferAttribute(vertices, index ? index.getX(i + j) : i + j)
                );
                fillPath += `M${x(triangle[0])},${y(triangle[0])}L${x(triangle[1])},${y(triangle[1])}L${x(triangle[2])},${y(triangle[2])}Z`;
            }
            surface.append(element('path', { d: fillPath, fill: '#8496a6', 'fill-rule': 'nonzero' }));

            // Отрисовка фурнитуры (зеленые линии)
            for (const { points, name } of fittings) {
                let d = '';
                for (let i = 0; i + 1 < points.length; i += 2)
                    d += `M${x(points[i])},${y(points[i])}L${x(points[i + 1])},${y(points[i + 1])}`;
                activeLayer = 'hardware';
                activeFitting = name;
                element('path', { d, fill: 'none', stroke: '#159447', 'stroke-width': 1.2 });
            }
            activeLayer = activeFitting = null;

            // Отрисовка контуров (рёбер) детали
            let d = '';
            for (let i = 0; i < positions.count; i += 2) {
                const p = new THREE.Vector3().fromBufferAttribute(positions, i),
                    q = new THREE.Vector3().fromBufferAttribute(positions, i + 1);
                d += `M${x(p)},${y(p)}L${x(q)},${y(q)}`;
            }
            element('path', { d, fill: 'none', stroke: '#34495e', 'stroke-width': 1 });

            // --- Отрисовка размеров ---
            activeLayer = 'dimensions';
            const horizontalDimension = document.createElementNS(ns, 'g');
            projectionGroup.append(horizontalDimension);
            targetGroup = horizontalDimension;
            element('path', {
                d: `M${left},${top + height + 4}v20M${left + width},${top + height + 4}v20`,
                stroke: '#a7b2bc', 'stroke-width': 0.7, fill: 'none'
            });
            dimension(left, top + height + 20, left + width, top + height + 20, `${a.toUpperCase()} ${fmt(size[a])}`);

            const verticalDimension = document.createElementNS(ns, 'g');
            projectionGroup.append(verticalDimension);
            targetGroup = verticalDimension;
            element('path', {
                d: `M${left - 4},${top}h-20M${left - 4},${top + height}h-20`,
                stroke: '#a7b2bc', 'stroke-width': 0.7, fill: 'none'
            });
            dimension(left - 20, top, left - 20, top + height, `${b.toUpperCase()} ${fmt(size[b])}`, true);

            targetGroup = projectionGroup;
            projections.push({
                group: projectionGroup,
                horizontal: horizontalDimension,
                vertical: verticalDimension,
                bottom: top + height,
                left, top, width,
                dimensionY: top + height + 20,
                dimensionX: left - 20
            });

            // --- Отрисовка отверстий (сверловок) ---
            const viewHoles = holes
                .filter((hole) => Math.abs(hole.direction[normal]) >= 0.99) // Только те, что смотрят в эту плоскость
                .sort((p, q) => q.center[b] - p.center[b]);
                
            for (const hole of viewHoles) {
                activeLayer = 'holes';
                activeFitting = hole.name;
                const cx = x(hole.center),
                    cy = y(hole.center),
                    r = (hole.diameter * scale) / 2;
                element('circle', { cx, cy, r, fill: 'none', stroke: '#c82d2d', 'stroke-width': 1.3 });
                // Отрисовка перекрестия
                element('path', {
                    d: `M${cx - r - 3},${cy}h${2 * r + 6}M${cx},${cy - r - 3}v${2 * r + 6}`,
                    stroke: '#c82d2d', 'stroke-width': 0.7
                });
            }

            // --- Размеры для отверстий ---
            for (const axis of [a, b]) {
                const coordinates = new Map();
                for (const hole of viewHoles) {
                    const value = (hole.center[axis] - bounds.min[axis]).toFixed(3);
                    if (!coordinates.has(value)) coordinates.set(value, []);
                    coordinates.get(value).push(hole);
                }
                for (const [value, group] of coordinates) {
                    activeLayer = 'dimensions';
                    activeFitting = null;
                    const vertical = axis === b;
                    const anchor = group.reduce((best, hole) =>
                        vertical
                            ? x(hole.center) - (hole.diameter * scale) / 2 < x(best.center) - (best.diameter * scale) / 2
                                ? hole : best
                            : y(hole.center) + (hole.diameter * scale) / 2 > y(best.center) + (best.diameter * scale) / 2
                              ? hole : best
                    );
                    const cx = x(anchor.center),
                        cy = y(anchor.center),
                        r = (anchor.diameter * scale) / 2;
                        
                    const node = annotation(
                        vertical ? cx - r - 16 : cx,
                        vertical ? cy : cy + r + 18,
                        `${axis.toUpperCase()} ${fmt(Number(value))}`,
                        vertical
                    );
                    node.dataset.coordinate = axis;
                    node.dataset.coordinateSide = vertical ? 'left' : 'bottom';
                    node.dataset.anchorX = cx;
                    node.dataset.anchorY = cy;
                    node.dataset.fittings = JSON.stringify([...new Set(group.map((hole) => hole.name))]);
                    const guide = element('path', { fill: 'none', stroke: '#9eabb5', 'stroke-width': 0.6 });
                    guide.dataset.coordinateGuide = 'true';
                    guide.dataset.fittings = node.dataset.fittings;
                    movableLabels[movableLabels.length - 1].guide = guide;
                }
            }

            // --- Подписи для отверстий (диаметр и глубина) ---
            const holeCaptions = new Map();
            for (const hole of viewHoles) {
                const key = `${hole.diameter.toFixed(3)}:${hole.depth.toFixed(3)}`;
                if (!holeCaptions.has(key)) holeCaptions.set(key, []);
                holeCaptions.get(key).push(hole);
            }
            for (const group of holeCaptions.values()) {
                const hole = group[0];
                activeLayer = 'dimensions';
                activeFitting = null;
                const node = annotation(
                    x(hole.center) + (hole.diameter * scale) / 2 + 55,
                    y(hole.center) - (hole.diameter * scale) / 2 - 25,
                    `Ø${fmt(hole.diameter)} · ↧${fmt(hole.depth)}`,
                    false,
                    '#b82222'
                );
                node.dataset.holeCaption = 'true';
                node.dataset.fittings = JSON.stringify([...new Set(group.map((h) => h.name))]);
            }
            activeLayer = activeFitting = null;
        }
        targetGroup = svg;
        edges.dispose();
        geometry.dispose();

        // ==========================================
        // 5. ИНТЕРФЕЙС (ЗУМ, ПАНЕЛЬ ФИЛЬТРОВ)
        // ==========================================

        const viewport = document.createElement('div');
        viewport.className = 'drawing-viewport';
        viewport.append(svg);

        const filters = document.createElement('div');
        filters.className = 'drawing-filters';
        const fittingChecks = new Map();

        // Утилита для создания чекбокса фильтра
        const checkbox = (title, handler) => {
            const label = document.createElement('label'),
                input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = true;
            const text = document.createElement('span');
            text.textContent = title;
            label.append(input, text);
            filters.append(label);
            input.onchange = handler;
            return input;
        };

        // Функция обновления видимости слоёв
        const refreshLayers = () => {
            for (const node of svg.querySelectorAll('[data-drawing-layer]')) {
                const enabled = node.dataset.fittings
                    ? JSON.parse(node.dataset.fittings).some((name) => fittingChecks.get(name)?.checked !== false)
                    : !node.dataset.fitting || fittingChecks.get(node.dataset.fitting)?.checked !== false;
                const layer = node.dataset.drawingLayer;
                node.style.display =
                    enabled &&
                    (layer !== 'dimensions' || dimensionsCheck.checked) &&
                    (layer !== 'hardware' || hardwareCheck.checked)
                        ? ''
                        : 'none';
            }
        };

        const dimensionsCheck = checkbox('Размеры', refreshLayers),
            hardwareCheck = checkbox('Фурнитура', refreshLayers);
            
        for (const name of new Set([...fittings.map((f) => f.name), ...holes.map((h) => h.name)]))
            fittingChecks.set(name, checkbox(name.split('\r')[0], refreshLayers));

        // Логика масштабирования (Zoom)
        let full = { x: 0, y: 0, width: 1700, height: 1000 },
            view = { ...full },
            zoom = 1;
        const zoomLabel = document.createElement('output');
        zoomLabel.className = 'drawing-zoom';

        const paintView = () => {
            svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
            zoomLabel.textContent = Math.round(zoom * 100) + '%';
        };

        function zoomAt(factor, point = { x: view.x + view.width / 2, y: view.y + view.height / 2 }) {
            const next = Math.max(0.5, Math.min(16, zoom * factor)),
                ratio = zoom / next;
            view = {
                x: point.x - (point.x - view.x) * ratio,
                y: point.y - (point.y - view.y) * ratio,
                width: view.width * ratio,
                height: view.height * ratio
            };
            zoom = next;
            paintView();
        }

        function tool(text, title, action) {
            const button = document.createElement('button');
            button.textContent = text;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.onclick = action;
            return button;
        }

        const fit = () => {
            zoom = 1;
            view = { ...full };
            paintView();
        };

        actions.prepend(
            tool('−', 'Уменьшить', () => zoomAt(1 / 1.25)),
            zoomLabel,
            tool('+', 'Увеличить', () => zoomAt(1.25))
        );

        // Выбор размера шрифта подписей
        const textSize = document.createElement('select');
        textSize.setAttribute('aria-label', 'Размер подписей');
        for (const [value, text] of [
            [0.5, 'Подписи 50%'], [0.75, 'Подписи 75%'],
            [1, 'Подписи 100%'], [1.25, 'Подписи 125%'], [1.5, 'Подписи 150%']
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            textSize.append(option);
        }
        textSize.value = '1';
        actions.insertBefore(textSize, close);

        const texts = [...svg.querySelectorAll('text')].map((node) => ({
            node,
            size: Number(node.getAttribute('font-size') || 12)
        }));
        
        textSize.onchange = () => {
            for (const { node, size } of texts) node.setAttribute('font-size', size * Number(textSize.value));
            arrangeLabels();
            updateSheet();
        };

        // ==========================================
        // 6. ОБРАБОТКА МЫШИ И ТАЧА (ПЕРЕТАСКИВАНИЕ И ЗУМ)
        // ==========================================
        const localPoint = (event) =>
            new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());

        svg.addEventListener(
            'wheel',
            (event) => {
                event.preventDefault();
                zoomAt(Math.exp(-Math.max(-150, Math.min(150, event.deltaY)) * 0.002), localPoint(event));
            },
            { passive: false }
        );

        const pointers = new Map();
        const gesture = () => {
            const points = [...pointers.values()].slice(0, 2);
            return {
                clientX: points.reduce((sum, p) => sum + p.clientX, 0) / points.length,
                clientY: points.reduce((sum, p) => sum + p.clientY, 0) / points.length,
                distance:
                    points.length === 2
                        ? Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY)
                        : 0
            };
        };

        svg.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
            svg.setPointerCapture(event.pointerId);
            viewport.classList.add('dragging');
        });

        svg.addEventListener('pointermove', (event) => {
            if (!pointers.has(event.pointerId)) return;
            event.preventDefault();
            const previous = gesture(),
                anchor = localPoint(previous);
            pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
            const current = gesture();
            if (previous.distance > 2 && current.distance > 2) zoomAt(current.distance / previous.distance, anchor);
            const after = localPoint(current);
            view.x += anchor.x - after.x;
            view.y += anchor.y - after.y;
            paintView();
        });

        const endDrag = (event) => {
            pointers.delete(event.pointerId);
            if (!pointers.size) viewport.classList.remove('dragging');
        };
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);
        svg.addEventListener('lostpointercapture', endDrag);
        svg.addEventListener('dblclick', fit);

        const hint = document.createElement('div');
        hint.className = 'drawing-hint';
        hint.textContent = 'Два пальца или колесо - масштаб · Перетаскивание - перемещение · Двойной клик - вписать';

        dialog.append(actions, heading, filters, viewport, hint);
        document.body.append(dialog);
        dialog.addEventListener('close', () => dialog.remove());
        dialog.showModal();
        
        arrangeLabels();

        // ==========================================
        // 7. ФИНАЛЬНАЯ КОМПОНОВКА ЧЕРТЕЖА
        // ==========================================
        function updateSheet() {
            const [front, lower, side] = projections.map((p) => p.group.getBBox());
            const dx = Math.max(0, 24 - front.x),
                dy = Math.max(0, 90 - front.y);
            const transforms = [
                { x: dx, y: dy },
                { x: dx, y: dy + front.y + front.height + 65 - lower.y },
                { x: dx + front.x + front.width + 65 - side.x, y: dy }
            ];
            const boxes = projections.map((p, i) => {
                const b = p.group.getBBox(),
                    t = transforms[i];
                p.group.setAttribute('transform', `translate(${t.x} ${t.y})`);
                return { x: b.x + t.x, y: b.y + t.y, width: b.width, height: b.height };
            });
            
            const minX = Math.min(0, ...boxes.map((b) => b.x)),
                minY = Math.min(0, ...boxes.map((b) => b.y));
            const right = Math.max(500, ...boxes.map((b) => b.x + b.width)) + 35,
                bottom = Math.max(300, ...boxes.map((b) => b.y + b.height)) + 35;
                
            full = { x: minX, y: minY, width: right - minX, height: bottom - minY };
            
            const background = svg.querySelector('rect');
            background.setAttribute('width', right);
            background.setAttribute('height', bottom);
            
            fit();
        }
        updateSheet();
    }

    // Экспорт модуля
    const api = { open };
    root.PartDrawing = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
