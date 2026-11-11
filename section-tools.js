'use strict';

/**
 * Модуль инструментов разреза (сечения) модели.
 * Позволяет "разрезать" 3D-модель плоскостью, показывая её внутреннее строение,
 * и автоматически создаёт визуальную "штриховку" (caps) в местах среза.
 */
window.createSectionTools = function ({ getEngine, getModel, render }) {
    const $ = (id) => document.getElementById(id);
    
    // Состояние инструмента разреза
    let cut = { enabled: false, axis: 'x', position: 50, reverse: false };
    
    // Текущая плоскость отсечения (THREE.Plane) и модель, к которой она применена
    let plane = null,
        appliedModel = null;
        
    // Кэш для хранения изначального значения material.side (чтобы вернуть как было при выключении разреза)
    const materialSides = new WeakMap();
    
    // Группа для "заглушек" (штриховки) на месте разреза
    let caps = null,
        capMaterial = null,
        capOutlineMaterial = null;

    /**
     * Очищает (удаляет) все созданные ранее "заглушки" среза из сцены и освобождает память.
     */
    function clearCaps() {
        if (!caps) return;
        if (caps.parent) caps.parent.remove(caps);
        caps.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
        });
        caps = null;
    }

    /**
     * Пересоздаёт "заглушки" (срезы) для всех панелей.
     */
    function rebuildCaps(engine, model) {
        clearCaps();
        if (!plane || !window.SectionCaps) return;

        // Создаём текстуру для штриховки среза (бежевый фон с красными линиями)
        if (!capMaterial) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 64;
            const context = canvas.getContext('2d');
            
            // Заливаем фон (цвет МДФ/ДСП)
            context.fillStyle = '#eadfc8';
            context.fillRect(0, 0, 64, 64);
            
            // Рисуем диагональные красные линии (штриховка)
            context.strokeStyle = '#ff2020';
            context.lineWidth = 3;
            for (let offset = -64; offset <= 64; offset += 32) {
                context.beginPath();
                context.moveTo(offset, 0);
                context.lineTo(offset + 64, 64);
                context.stroke();
            }
            
            const texture = new THREE.CanvasTexture(canvas);
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            
            // Материал для заливки среза
            capMaterial = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1
            });
            
            // Материал для красной обводки среза
            capOutlineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: true, depthWrite: false });
        }

        caps = new THREE.Group();

        // Проходим по всем панелям и строим для них геометрию среза
        for (const panel of model.panels) {
            // Функция geometry из section-caps.js строит 2D-полигоны в месте пересечения плоскости и панели
            const geometry = window.SectionCaps.geometry(panel.geometry, plane, THREE);
            
            // Если плоскость не пересекает эту панель, пропускаем
            if (!geometry.attributes.position.count) {
                geometry.dispose();
                continue;
            }

            const cap = new THREE.Mesh(geometry, capMaterial);
            cap.userData.source = panel; // Ссылка на оригинальную панель (чтобы скрывать вместе с ней)

            // Создаём красный контур вокруг среза
            const outlineGeometry = new THREE.BufferGeometry();
            outlineGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(geometry.userData.sectionOutline, 3)
            );
            const outline = new THREE.LineSegments(outlineGeometry, capOutlineMaterial);
            outline.renderOrder = 2;
            cap.add(outline);

            cap.visible = panel.visible;
            caps.add(cap);
        }
        
        engine.scene.add(caps);
    }

    /**
     * Применяет текущие настройки разреза (включает/выключает, меняет ось или позицию).
     */
    function applyCut() {
        const engine = getEngine(),
            model = getModel();
            
        clearCaps();
        plane = null;
        appliedModel = model;
        
        if (!engine) return;
        engine.renderer.localClippingEnabled = true;

        // Вычисляем координату и нормаль плоскости, если разрез включен
        if (model && cut.enabled) {
            const coordinate =
                model.bounds.min[cut.axis] +
                ((model.bounds.max[cut.axis] - model.bounds.min[cut.axis]) * cut.position) / 100;
                
            const normal = new THREE.Vector3();
            normal[cut.axis] = cut.reverse ? -1 : 1;
            
            // Формула плоскости: ax + by + cz + d = 0
            plane = new THREE.Plane(normal, -coordinate * normal[cut.axis]);
        }

        // Применяем плоскость ко всем материалам модели и фурнитуры
        if (model)
            for (const group of [model.group, model.hardware])
                group.traverse((object) => {
                    if (!object.material) return;
                    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                        // Запоминаем изначальную сторону (FrontSide или BackSide), если ещё не запомнили
                        if (!materialSides.has(material)) materialSides.set(material, material.side);
                        
                        // Включаем отсечение по плоскости
                        material.clippingPlanes = plane ? [plane] : [];
                        material.clipShadows = true;
                        
                        // Если разрез включён, делаем материал двусторонним, чтобы видеть внутренности.
                        // Если выключен — возвращаем как было.
                        material.side = plane ? THREE.DoubleSide : materialSides.get(material);
                        material.needsUpdate = true;
                    }
                });

        if (model) rebuildCaps(engine, model);
    }

    /**
     * Синхронизирует состояние UI-элементов (ползунков и чекбоксов) с внутренним состоянием.
     */
    function syncCut() {
        $('section-enabled').checked = cut.enabled;
        $('section-axis').value = cut.axis;
        $('section-position').value = cut.position;
        $('section-reverse').checked = cut.reverse;
        $('section-value').textContent = Math.round(cut.position) + '%';
        
        for (const id of ['section-axis', 'section-position', 'section-reverse']) $(id).disabled = !cut.enabled;
    }

    /**
     * Проверяет, видна ли точка (не отрезана ли она плоскостью).
     * Используется при кликах мышкой, чтобы нельзя было выбрать отрезанную часть.
     */
    function isVisible(point) {
        return !plane || plane.distanceToPoint(point) >= -0.001;
    }

    /**
     * Вызывается каждый кадр из главного цикла рендера.
     */
    function renderSection() {
        if (!getEngine()) return;
        if (getModel() !== appliedModel) applyCut();
        
        // Синхронизируем видимость "заглушек" с видимостью самих панелей
        if (caps) for (const cap of caps.children) cap.visible = cap.userData.source.visible;
    }

    /**
     * Сбрасывает разрез в исходное состояние (выключено).
     */
    function reset() {
        cut = { enabled: false, axis: 'x', position: 50, reverse: false };
        applyCut();
        syncCut();
    }

    // Навешиваем обработчики на элементы управления (ползунки, чекбоксы)
    for (const id of ['section-enabled', 'section-axis', 'section-position', 'section-reverse'])
        $(id).addEventListener('input', () => {
            cut = {
                enabled: $('section-enabled').checked,
                axis: $('section-axis').value,
                position: Number($('section-position').value),
                reverse: $('section-reverse').checked
            };
            syncCut();
            applyCut();
            render();
        });

    syncCut();
    
    // Экспорт модуля
    return { reset, isVisible, render: renderSection, state: () => ({ section: { ...cut } }) };
};
