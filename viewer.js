'use strict';

// ==========================================
// 1. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И СОСТОЯНИЕ
// ==========================================

// Быстрый доступ к DOM-элементам по ID
const $ = (id) => document.getElementById(id);

// Массив открытых пользователем файлов
const files = [];

// Основные переменные состояния приложения
let selected = null,        // Текущий выбранный файл
    request = 0,            // Токен для отмены асинхронных операций при смене модели
    model = null,           // Объект модели (панели, фурнитура, дерево)
    engine = null,          // Объект Three.js (сцена, камера, рендерер)
    highlighted = null;     // Выделенная в данный момент панель

let highlightedGroup = null; // Группа выделенных панелей (при Shift+клик)
let tool = 'select',        // Активный инструмент ('select' или 'measure')
    pendingPoint = null,    // Первая точка измерения (когда ждем вторую)
    pendingMarker = null,   // Визуальный маркер первой точки
    isolated = false;       // Режим изоляции (показана только одна деталь)

const measurements = [];    // Массив всех созданных измерений

// Названия вкладок в правой панели
const tabNames = {
    view: 'Вид и навигация',
    parts: 'Выбранная деталь',
    tree: 'Структура модели',
    search: 'Поиск по позициям',
    measure: 'Измерения',
    materials: 'Материалы',
    files: 'Модель и файлы',
    render: 'Настройки рендера'
};

let activeTab = 'view',     // Текущая открытая вкладка
    hoverGraphic = null;    // Визуальный маркер под курсором (для привязок)

let heldSnap = null;        // "Зажатая" привязка (если пользователь ведет курсор рядом с вершиной)
let materialEditor = 'color', // Режим редактора материалов ('color', 'texture', 'light')
    ledBaker = null,        // Объект для "запекания" света от LED-профилей
    choosingLightFace = false; // Режим выбора грани для LED-подсветки

let savedColorScope = null, // Сохраненное значение области применения цвета
    fpsFrames = 0,          // Счетчик кадров для FPS
    fpsPending = false,     // Флаг, чтобы не запускать несколько requestAnimationFrame
    fpsSince = performance.now(); // Время начала замера FPS

// Обновление счетчика FPS раз в секунду
window.setInterval(() => {
    const now = performance.now();
    $('viewer-fps').textContent = document.hidden
        ? '- FPS'
        : Math.round((fpsFrames * 1000) / Math.max(1, now - fpsSince)) + ' FPS';
    fpsFrames = 0;
    fpsSince = now;
}, 1000);

// Настройки LED-подсветки по умолчанию
const defaultLight = { color: '#fff1d6', power: 1, distance: 1200 };

// Деталь, на которой было вызвано контекстное меню
let contextPart = null;

// Кэш загруженных текстур (чтобы не грузить одну и ту же картинку дважды)
const textureAssets = new Map();
// Счетчик операций с текстурами (для отмены устаревших асинхронных загрузок)
let textureOperation = 0;

// Инициализация инструментов сечения и дерева модели
const sectionTools = window.createSectionTools({ getEngine: () => engine, getModel: () => model, render });
const treeTools = window.createModelTree({
    getModel: () => model,
    getSelection: () => highlightedGroup?.id || highlighted?.userData.treeNodeId || null,
    selectPart,
    selectGroup: selectTreeGroup,
    focus: focusTreeParts,
    visibilityChanged: treeVisibilityChanged
});

// Названия типов привязок (для подсказок при измерении)
const snapNames = {
    vertex: 'Угол / вершина',
    midpoint: 'Середина ребра',
    edge: 'Точка на ребре',
    center: 'Центр плоскости',
    plane: 'Перпендикуляр к плоскости',
    surface: 'Поверхность'
};

// ==========================================
// 2. БАЗЫ ДАННЫХ (ЦВЕТА, МАТЕРИАЛЫ, ТЕКСТУРЫ)
// ==========================================

// Быстрая палитра цветов для кнопок-кружочков
const swatches = [
    '#ffffff', '#f5f5f0', '#dce0df', '#beb9ac', '#d1b48c', '#b88a53',
    '#8e6243', '#5c4033', '#453b33', '#303640', '#15191f', '#8B0000'
];

/**
 * Справочник материалов.
 * Позволяет автоматически назначать цвет и свойства материала по названию из B3D.
 * Поиск идет по вхождению подстроки (регистр не важен).
 */
const materialDatabase = {
    'дуб бардолино': { color: '#c2a77d', roughness: 0.7 },
    'серый перламутровый': { color: '#9fa3a6', roughness: 0.6 },
    'хдф': { color: '#f0ece1', roughness: 0.9 },
    'крепеж': { color: '#cccccc', roughness: 0.2, metalness: 0.8 },
    'петля': { color: '#aaaaaa', roughness: 0.3, metalness: 0.9 },
    'направляющая': { color: '#e0e0e0', roughness: 0.4, metalness: 0.7 }
};

/**
 * Библиотека текстур для галереи.
 * Содержит пути к файлам в папках 'textures/color' и 'textures/wood'.
 * (Полный список текстур оставлен без изменений, чтобы не раздувать код).
 */
// Массив текстур для галереи (полный список)
const textureLibrary = [
    { name: 'U104 ST9 Алебастр белый', path: 'textures/color/U104 ST9 Алебастр белый.jpg' },
    { name: 'U107 ST9 Бархат жёлтый', path: 'textures/color/U107 ST9 Бархат жёлтый.jpg' },
    { name: 'U108 ST9 Ванильный жёлтый', path: 'textures/color/U108 ST9 Ванильный жёлтый.jpg' },
    { name: 'U113 ST9 Коттон бежевый', path: 'textures/color/U113 ST9 Коттон бежевый.jpg' },
    { name: 'U114 ST9 Жёлтый бриллиант', path: 'textures/color/U114 ST9 Жёлтый бриллиант.jpg' },
    { name: 'U131 ST9 Цитрусовый жёлтый', path: 'textures/color/U131 ST9 Цитрусовый жёлтый.jpg' },
    { name: 'U140 ST9 Шафрановый жёлтый', path: 'textures/color/U140 ST9 Шафрановый жёлтый.jpg' },
    { name: 'U146 ST9 Кукурузный жёлтый', path: 'textures/color/U146 ST9 Кукурузный жёлтый.jpg' },
    { name: 'U156 ST9 Бежевый песок', path: 'textures/color/U156 ST9 Бежевый песок.jpg' },
    { name: 'U163 ST9 Карри жёлтый', path: 'textures/color/U163 ST9 Карри жёлтый.jpg' },
    { name: 'U200 ST9 Бежевый', path: 'textures/color/U200 ST9 Бежевый.jpg' },
    { name: 'U201 ST9 Серая галька', path: 'textures/color/U201 ST9 Серая галька.jpg' },
    { name: 'U216 ST9 Камель бежевый', path: 'textures/color/U216 ST9 Камель бежевый.jpg' },
    { name: 'U222 ST9 Крем бежевый', path: 'textures/color/U222 ST9 Крем бежевый.jpg' },
    { name: 'U232 ST9 Абрикос нюд', path: 'textures/color/U232 ST9 Абрикос нюд.jpg' },
    { name: 'U311 ST9 Бургундский красный', path: 'textures/color/U311 ST9 Бургундский красный.jpg' },
    { name: 'U313 ST9 Белая роза', path: 'textures/color/U313 ST9 Белая роза.jpg' },
    { name: 'U321 ST9 Красный китайский', path: 'textures/color/U321 ST9 Красный китайский.jpg' },
    { name: 'U323 ST9 Ярко-красный', path: 'textures/color/U323 ST9 Ярко-красный.jpg' },
    { name: 'U325 ST9 Розовый антик', path: 'textures/color/U325 ST9 Розовый антик.jpg' },
    { name: 'U328 ST9 Помадный красный', path: 'textures/color/U328 ST9 Помадный красный.jpg' },
    { name: 'U330 ST9 Баклажан фиолетовый', path: 'textures/color/U330 ST9 Баклажан фиолетовый.jpg' },
    { name: 'U332 ST9 Оранжевый', path: 'textures/color/U332 ST9 Оранжевый.jpg' },
    { name: 'U337 ST9 Фуксия розовая', path: 'textures/color/U337 ST9 Фуксия розовая.jpg' },
    { name: 'U340 ST9 Щербет оранж', path: 'textures/color/U340 ST9 Щербет оранж.jpg' },
    { name: 'U350 ST9 Сиена оранж', path: 'textures/color/U350 ST9 Сиена оранж.jpg' },
    { name: 'U363 ST9 Фламинго розовый', path: 'textures/color/U363 ST9 Фламинго розовый.jpg' },
    { name: 'U390 ST9 Индийский красный', path: 'textures/color/U390 ST9 Индийский красный.jpg' },
    { name: 'U399 ST9 Красный гранат', path: 'textures/color/U399 ST9 Красный гранат.jpg' },
    { name: 'U400 ST9 Фиолетовый нежный', path: 'textures/color/U400 ST9 Фиолетовый нежный.jpg' },
    { name: 'U404 ST9 Крокус фиолетовый', path: 'textures/color/U404 ST9 Крокус фиолетовый.jpg' },
    { name: 'U414 ST9 Фиолетовый темный', path: 'textures/color/U414 ST9 Фиолетовый темный.jpg' },
    { name: 'U420 ST9 Лиловый', path: 'textures/color/U420 ST9 Лиловый.jpg' },
    { name: 'U430 ST9 Фиолетовый', path: 'textures/color/U430 ST9 Фиолетовый.jpg' },
    { name: 'U500 ST9 Аква голубой', path: 'textures/color/U500 ST9 Аква голубой.jpg' },
    { name: 'U504 ST9 Альпийское озеро', path: 'textures/color/U504 ST9 Альпийское озеро.jpg' },
    { name: 'U507 ST9 Дымчато-голубой', path: 'textures/color/U507 ST9 Дымчато-голубой.jpg' },
    { name: 'U515 ST9 Французский голубой', path: 'textures/color/U515 ST9 Французский голубой.jpg' },
    { name: 'U522 ST9 Голубой горизонт', path: 'textures/color/U522 ST9 Голубой горизонт.jpg' },
    { name: 'U525 ST9 Делфт голубой', path: 'textures/color/U525 ST9 Делфт голубой.jpg' },
    { name: 'U533 ST9 Полярный голубой', path: 'textures/color/U533 ST9 Полярный голубой.jpg' },
    { name: 'U540 ST9 Деним голубой', path: 'textures/color/U540 ST9 Деним голубой.jpg' },
    { name: 'U560 ST9 Синяя глубина', path: 'textures/color/U560 ST9 Синяя глубина.jpg' },
    { name: 'U570 ST9 Синяя ночь', path: 'textures/color/U570 ST9 Синяя ночь.jpg' },
    { name: 'U599 ST9 Индиго синий', path: 'textures/color/U599 ST9 Индиго синий.jpg' },
    { name: 'U600 ST9 Зелёный май', path: 'textures/color/U600 ST9 Зелёный май.jpg' },
    { name: 'U606 ST9 Зелёный лес', path: 'textures/color/U606 ST9 Зелёный лес.jpg' },
    { name: 'U608 ST9 Зелёный фисташковый', path: 'textures/color/U608 ST9 Зелёный фисташковый.jpg' },
    { name: 'U617 ST9 Зелёный васаби', path: 'textures/color/U617 ST9 Зелёный васаби.jpg' },
    { name: 'U626 ST9 Зелёный киви', path: 'textures/color/U626 ST9 Зелёный киви.jpg' },
    { name: 'U630 ST9 Зелёный лайм', path: 'textures/color/U630 ST9 Зелёный лайм.jpg' },
    { name: 'U633 ST9 Бирюза зелёная', path: 'textures/color/U633 ST9 Бирюза зелёная.jpg' },
    { name: 'U636 ST9 Фьёрд зелёный', path: 'textures/color/U636 ST9 Фьёрд зелёный.jpg' },
    { name: 'U646 ST9 Ниагара зелёный', path: 'textures/color/U646 ST9 Ниагара зелёный.jpg' },
    { name: 'U650 ST9 Папоротник зелёный', path: 'textures/color/U650 ST9 Папоротник зелёный.jpg' },
    { name: 'U655 ST9 Зелёный изумрудный', path: 'textures/color/U655 ST9 Зелёный изумрудный.jpg' },
    { name: 'U660 ST9 Зелёные джунгли', path: 'textures/color/U660 ST9 Зелёные джунгли.jpg' },
    { name: 'U702 ST9 Кашемир серый', path: 'textures/color/U702 ST9 Кашемир серый.jpg' },
    { name: 'U7021 ST9 Кашемир серый сплошной', path: 'textures/color/U7021 ST9 Кашемир серый сплошной.jpg' },
    { name: 'U705 ST9 Ангора серая', path: 'textures/color/U705 ST9 Ангора серая.jpg' },
    { name: 'U707 ST9 Шёлк серый', path: 'textures/color/U707 ST9 Шёлк серый.jpg' },
    { name: 'U708 ST9 Светло-серый', path: 'textures/color/U708 ST9 Светло-серый.jpg' },
    { name: 'U7081 ST9 Светло-серый сплошной', path: 'textures/color/U7081 ST9 Светло-серый сплошной.jpg' },
    { name: 'U717 ST9 Дакар серый', path: 'textures/color/U717 ST9 Дакар серый.jpg' },
    { name: 'U727 ST9 Серый камень', path: 'textures/color/U727 ST9 Серый камень.jpg' },
    { name: 'U732 ST9 Серый пыльный', path: 'textures/color/U732 ST9 Серый пыльный.jpg' },
    { name: 'U740 ST9 Cеро-коричневый тёмный', path: 'textures/color/U740 ST9 Cеро-коричневый тёмный.jpg' },
    { name: 'U741 ST9 Лава серая', path: 'textures/color/U741 ST9 Лава серая.jpg' },
    { name: 'U748 ST9 Трюфель коричневый', path: 'textures/color/U748 ST9 Трюфель коричневый.jpg' },
    { name: 'U750 ST9 Ярко-серый', path: 'textures/color/U750 ST9 Ярко-серый.jpg' },
    { name: 'U763 ST9 Серый перламутровый', path: 'textures/color/U763 ST9 Серый перламутровый.jpg' },
    { name: 'U767 ST9 Кубанит серый', path: 'textures/color/U767 ST9 Кубанит серый.jpg' },
    { name: 'U775 ST9 Бело-серый', path: 'textures/color/U775 ST9 Бело-серый.jpg' },
    { name: 'U780 ST9 Серый монументальный', path: 'textures/color/U780 ST9 Серый монументальный.jpg' },
    { name: 'U788 ST16 Арктика серый', path: 'textures/color/U788 ST16 Арктика серый.jpg' },
    { name: 'U807 ST9 Нуга коричневый', path: 'textures/color/U807 ST9 Нуга коричневый.jpg' },
    { name: 'U818 ST9 Тёмно-коричневый', path: 'textures/color/U818 ST9 Тёмно-коричневый.jpg' },
    { name: 'U830 ST9 Карамель нюд', path: 'textures/color/U830 ST9 Карамель нюд.jpg' },
    { name: 'U8991 ST9 Нежный чёрный сплошной', path: 'textures/color/U8991 ST9 Нежный чёрный сплошной.jpg' },
    { name: 'U960 ST76 Оникс серый', path: 'textures/color/U960 ST76 Оникс серый.jpg' },
    { name: 'U961 ST2 Чёрный графит', path: 'textures/color/U961 ST2 Чёрный графит.jpg' },
    { name: 'U963 ST9 Диамант серый', path: 'textures/color/U963 ST9 Диамант серый.jpg' },
    { name: 'U9631 ST9 Диамант серый сплошной', path: 'textures/color/U9631 ST9 Диамант серый сплошной.jpg' },
    { name: 'U968 ST9 Серый уголь', path: 'textures/color/U968 ST9 Серый уголь.jpg' },
    { name: 'U989 ST9 Чёрно-коричневый', path: 'textures/color/U989 ST9 Чёрно-коричневый.jpg' },
    { name: 'U998 ST38 Лес чёрный', path: 'textures/color/U998 ST38 Лес чёрный.jpg' },
    { name: 'U999 ST19 Чёрный', path: 'textures/color/U999 ST19 Чёрный.jpg' },
    { name: 'W908 ST2 Белый базовый', path: 'textures/color/W908 ST2 Белый базовый.jpg' },
    { name: 'H1113 ST10', path: 'textures/wood/H1113 ST10.jpg' },
    { name: 'H1115 ST12', path: 'textures/wood/H1115 ST12.jpg' },
    { name: 'H1122 ST22', path: 'textures/wood/H1122 ST22.jpg' },
    { name: 'H1123 ST22', path: 'textures/wood/H1123 ST22.jpg' },
    { name: 'H1137 ST12', path: 'textures/wood/H1137 ST12.jpg' },
    { name: 'H1145 ST10', path: 'textures/wood/H1145 ST10.jpg' },
    { name: 'H1146 ST10', path: 'textures/wood/H1146 ST10.jpg' },
    { name: 'H1150 ST10', path: 'textures/wood/H1150 ST10.jpg' },
    { name: 'H1151 ST10', path: 'textures/wood/H1151 ST10.jpg' },
    { name: 'H1176 ST37', path: 'textures/wood/H1176 ST37.jpg' },
    { name: 'H1180 ST37', path: 'textures/wood/H1180 ST37.jpg' },
    { name: 'H1181 ST37', path: 'textures/wood/H1181 ST37.jpg' },
    { name: 'H1199 ST12', path: 'textures/wood/H1199 ST12.jpg' },
    { name: 'H1210 ST33', path: 'textures/wood/H1210 ST33.jpg' },
    { name: 'H1212 ST33', path: 'textures/wood/H1212 ST33.jpg' },
    { name: 'H1250 ST36', path: 'textures/wood/H1250 ST36.jpg' },
    { name: 'H1251 ST19', path: 'textures/wood/H1251 ST19.jpg' },
    { name: 'H1252 ST19', path: 'textures/wood/H1252 ST19.jpg' },
    { name: 'H1253 ST19', path: 'textures/wood/H1253 ST19.jpg' },
    { name: 'H1277 ST9 Акация Лэйклэнд светлая', path: 'textures/wood/H1277 ST9 Акация Лэйклэнд светлая.jpg' },
    { name: 'H1298 ST22 Ясень Лион песочно-бежевый', path: 'textures/wood/H1298 ST22 Ясень Лион песочно-бежевый.jpg' },
    { name: 'H1312 ST10 Дуб Уайт-Ривер песочно-бежевый', path: 'textures/wood/H1312 ST10 Дуб Уайт-Ривер песочно-бежевый.jpg' },
    { name: 'H1313 ST10 Дуб Уайт-Ривер серо-коричневый', path: 'textures/wood/H1313 ST10 Дуб Уайт-Ривер серо-коричневый.jpg' },
    { name: 'H1318 ST10 Дикий дуб натуральный', path: 'textures/wood/H1318 ST10 Дикий дуб натуральный.jpg' },
    { name: 'H1330 ST10 Дуб Санта-Фе винтаж', path: 'textures/wood/H1330 ST10 Дуб Санта-Фе винтаж.jpg' },
    { name: 'H1331 ST10 Дуб Санта-Фе серый', path: 'textures/wood/H1331 ST10 Дуб Санта-Фе серый.jpg' },
    { name: 'H1334 ST9 Дуб Сорано натуральный светлый', path: 'textures/wood/H1334 ST9 Дуб Сорано натуральный светлый.jpg' },
    { name: 'H1336 ST37 Дуб Галифакс глазурованный песочно-серый', path: 'textures/wood/H1336 ST37 Дуб Галифакс глазурованный песочно-серый.jpg' },
    { name: 'H1344 ST32 Дуб Шерман коньяк коричневый', path: 'textures/wood/H1344 ST32 Дуб Шерман коньяк коричневый.jpg' },
    { name: 'H1345 ST32 Дуб Шерман серый', path: 'textures/wood/H1345 ST32 Дуб Шерман серый.jpg' },
    { name: 'H1346 ST32 Дуб Шерман антрацит', path: 'textures/wood/H1346 ST32 Дуб Шерман антрацит.jpg' },
    { name: 'H1377 ST36 Дуб Орлеанский песочно-бежевый', path: 'textures/wood/H1377 ST36 Дуб Орлеанский песочно-бежевый.jpg' },
    { name: 'H1379 ST36 Дуб Орлеанский коричневый', path: 'textures/wood/H1379 ST36 Дуб Орлеанский коричневый.jpg' },
    { name: 'H1387 ST10 Дуб Денвер графит', path: 'textures/wood/H1387 ST10 Дуб Денвер графит.jpg' },
    { name: 'H1399 ST10Дуб Денвер трюфель', path: 'textures/wood/H1399 ST10Дуб Денвер трюфель.jpg' },
    { name: 'H1400 ST36 Древесина Аттик', path: 'textures/wood/H1400 ST36 Древесина Аттик.jpg' },
    { name: 'H1401 ST22 Сосна Касцина', path: 'textures/wood/H1401 ST22 Сосна Касцина.jpg' },
    { name: 'H1424 ST22 Файнлайн крем', path: 'textures/wood/H1424 ST22 Файнлайн крем.jpg' },
    { name: 'H1486 ST36 Сосна Пасадена', path: 'textures/wood/H1486 ST36 Сосна Пасадена.jpg' },
    { name: 'H1487 ST22 Пихта Брамберг', path: 'textures/wood/H1487 ST22 Пихта Брамберг.jpg' },
    { name: 'H1511 ST15 Бук Бавария', path: 'textures/wood/H1511 ST15 Бук Бавария.jpg' },
    { name: 'H1582 ST15 Бук Эльмау', path: 'textures/wood/H1582 ST15 Бук Эльмау.jpg' },
    { name: 'H1615 ST9 Вишня Верона', path: 'textures/wood/H1615 ST9 Вишня Верона.jpg' },
    { name: 'H1636 ST12 Вишня Локарно', path: 'textures/wood/H1636 ST12 Вишня Локарно.jpg' },
    { name: 'H1701 ST33 Вяз Тоссини белый', path: 'textures/wood/H1701 ST33 Вяз Тоссини белый.jpg' },
    { name: 'H1702 ST33 Вяз Тоссини тёмно-коричневый', path: 'textures/wood/H1702 ST33 Вяз Тоссини тёмно-коричневый.jpg' },
    { name: 'H1710 ST10 Каштан Кентукки песочный', path: 'textures/wood/H1710 ST10 Каштан Кентукки песочный.jpg' },
    { name: 'H1714 ST19 Орех Линкольн', path: 'textures/wood/H1714 ST19 Орех Линкольн.jpg' },
    { name: 'H1733 ST9 Берёза Майнау', path: 'textures/wood/H1733 ST9 Берёза Майнау.jpg' },
    { name: 'H2033 ST10 Дуб Хантон тёмный', path: 'textures/wood/H2033 ST10 Дуб Хантон тёмный.jpg' },
    { name: 'H3012 ST22 Кокоболо натуральный', path: 'textures/wood/H3012 ST22 Кокоболо натуральный.jpg' },
    { name: 'H3058 ST22 Венге Мали', path: 'textures/wood/H3058 ST22 Венге Мали.jpg' },
    { name: 'H3090 ST22 Древесина Шорвуд', path: 'textures/wood/H3090 ST22 Древесина Шорвуд.jpg' },
    { name: 'H3131 ST12 Дуб Давос натуральный', path: 'textures/wood/H3131 ST12 Дуб Давос натуральный.jpg' },
    { name: 'H3133 ST12 Дуб Давос трюфель', path: 'textures/wood/H3133 ST12 Дуб Давос трюфель.jpg' },
    { name: 'H3146 ST19 Дуб Лоренцо бежево-серый', path: 'textures/wood/H3146 ST19 Дуб Лоренцо бежево-серый.jpg' },
    { name: 'H3154 ST36 Дуб Чарльстон тёмно-коричневый', path: 'textures/wood/H3154 ST36 Дуб Чарльстон тёмно-коричневый.jpg' },
    { name: 'H3156 ST12Дуб Корбридж серый', path: 'textures/wood/H3156 ST12Дуб Корбридж серый.jpg' },
    { name: 'H3157 ST12 Дуб Винченца', path: 'textures/wood/H3157 ST12 Дуб Винченца.jpg' },
    { name: 'H3158 ST19 Дуб Винченца серый', path: 'textures/wood/H3158 ST19 Дуб Винченца серый.jpg' },
    { name: 'H3170 ST12 Дуб Кендал натуральный', path: 'textures/wood/H3170 ST12 Дуб Кендал натуральный.jpg' },
    { name: 'H3171 ST12 Дуб Кендал промасленный', path: 'textures/wood/H3171 ST12 Дуб Кендал промасленный.jpg' },
    { name: 'H3176 ST37 Дуб Галифакс олово', path: 'textures/wood/H3176 ST37 Дуб Галифакс олово.jpg' },
    { name: 'H3178 ST37 Дуб Галифакс глазурованный чёрный', path: 'textures/wood/H3178 ST37 Дуб Галифакс глазурованный чёрный.jpg' },
    { name: 'H3190 ST19 Металлик Файнлайн антрацит', path: 'textures/wood/H3190 ST19 Металлик Файнлайн антрацит.jpg' },
    { name: 'H3192 ST19 Металлик Файнлайн коричневый', path: 'textures/wood/H3192 ST19 Металлик Файнлайн коричневый.jpg' },
    { name: 'H3303 ST10 Дуб Гамильтон натуральный', path: 'textures/wood/H3303 ST10 Дуб Гамильтон натуральный.jpg' },
    { name: 'H3309 ST28 Дуб Гладстоун песочный', path: 'textures/wood/H3309 ST28 Дуб Гладстоун песочный.jpg' },
    { name: 'H3325 ST28 Дуб Гладстоун табак', path: 'textures/wood/H3325 ST28 Дуб Гладстоун табак.jpg' },
    { name: 'H3326 ST28 Дуб Гладстоун серо-бежевый', path: 'textures/wood/H3326 ST28 Дуб Гладстоун серо-бежевый.jpg' },
    { name: 'H3330 ST36 Дуб Антор натуральный', path: 'textures/wood/H3330 ST36 Дуб Антор натуральный.jpg' },
    { name: 'H3331 ST10 Дуб Небраска натуральный', path: 'textures/wood/H3331 ST10 Дуб Небраска натуральный.jpg' },
    { name: 'H3332 ST10Дуб Небраска серый', path: 'textures/wood/H3332 ST10Дуб Небраска серый.jpg' },
    { name: 'H3335 ST28 Дуб Гладстоун белый', path: 'textures/wood/H3335 ST28 Дуб Гладстоун белый.jpg' },
    { name: 'H3342 ST28 Дуб Гладстоун сепия', path: 'textures/wood/H3342 ST28 Дуб Гладстоун сепия.jpg' },
    { name: 'H3344 ST36 Дуб Файнлайн натуральный', path: 'textures/wood/H3344 ST36 Дуб Файнлайн натуральный.jpg' },
    { name: 'H3368 ST9 Дуб Ланкастер натуральный', path: 'textures/wood/H3368 ST9 Дуб Ланкастер натуральный.jpg' },
    { name: 'H3395 ST12 Дуб Корбридж натуральный', path: 'textures/wood/H3395 ST12 Дуб Корбридж натуральный.jpg' },
    { name: 'H3398 ST12 Дуб Кендал коньяк', path: 'textures/wood/H3398 ST12 Дуб Кендал коньяк.jpg' },
    { name: 'H3403 ST38 Лиственница горная белая', path: 'textures/wood/H3403 ST38 Лиственница горная белая.jpg' },
    { name: 'H3404 ST38 Лиственница горная коричневая', path: 'textures/wood/H3404 ST38 Лиственница горная коричневая.jpg' },
    { name: 'H3406 ST38 Лиственница горная антрацит', path: 'textures/wood/H3406 ST38 Лиственница горная антрацит.jpg' },
    { name: 'H3408 ST38 Лиственница горная коричневая термо', path: 'textures/wood/H3408 ST38 Лиственница горная коричневая термо.jpg' },
    { name: 'H3430 ST22 Сосна Аланд белая', path: 'textures/wood/H3430 ST22 Сосна Аланд белая.jpg' },
    { name: 'H3433 ST22 Сосна Аланд полярная', path: 'textures/wood/H3433 ST22 Сосна Аланд полярная.jpg' },
    { name: 'H3450 ST22 Флитвуд белый', path: 'textures/wood/H3450 ST22 Флитвуд белый.jpg' },
    { name: 'H3451 ST22 Флитвуд шампань', path: 'textures/wood/H3451 ST22 Флитвуд шампань.jpg' },
    { name: 'H3453 ST22 Флитвуд серая лава', path: 'textures/wood/H3453 ST22 Флитвуд серая лава.jpg' },
    { name: 'H3470 ST22 Пихта сучковатая натуральная', path: 'textures/wood/H3470 ST22 Пихта сучковатая натуральная.jpg' },
    { name: 'H3700 ST10 Орех Пацифик натуральный', path: 'textures/wood/H3700 ST10 Орех Пацифик натуральный.jpg' },
    { name: 'H3702 ST10 Орех Пацифик табак', path: 'textures/wood/H3702 ST10 Орех Пацифик табак.jpg' },
    { name: 'H3710 ST9 Орех Карини натуральный', path: 'textures/wood/H3710 ST9 Орех Карини натуральный.jpg' },
    { name: 'H3730 ST10 Гикори натуральный', path: 'textures/wood/H3730 ST10 Гикори натуральный.jpg' },
    { name: 'H3734 ST9 Орех Дижон натуральный', path: 'textures/wood/H3734 ST9 Орех Дижон натуральный.jpg' },
    { name: 'H3840 ST9 Клён Мандал натуральный', path: 'textures/wood/H3840 ST9 Клён Мандал натуральный.jpg' },
    { name: 'H3860 ST9 Клён сахарный шампань', path: 'textures/wood/H3860 ST9 Клён сахарный шампань.jpg' },
    { name: 'ЛДСП Egger Древесина Аттик Н1400 ST36 2800207016', path: 'textures/wood/ЛДСП Egger Древесина Аттик Н1400 ST36 2800207016.jpg' },
    { name: 'ЛДСП Egger Древесина Белая Н1122 ST22 2800103016', path: 'textures/wood/ЛДСП Egger Древесина Белая Н1122 ST22 2800103016.jpg' },
    { name: 'ЛДСП Egger Древесина графит H1123 ST22 2800207016', path: 'textures/wood/ЛДСП Egger Древесина графит H1123 ST22 2800207016.jpg' },
    { name: 'ЛДСП Egger Древесина Шорвуд Н3090 ST22  2800207016', path: 'textures/wood/ЛДСП Egger Древесина Шорвуд Н3090 ST22  2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Аризона коричневый Н1151 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Аризона коричневый Н1151 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Бардолино натуральный Н1145 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Бардолино натуральный Н1145 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Бардолино серый  Н1146 ST 10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Бардолино серый  Н1146 ST 10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Винченца  H3157 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Винченца  H3157 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Галифакс белый  Н1176 ST37 2800103016', path: 'textures/wood/ЛДСП Egger Дуб Галифакс белый  Н1176 ST37 2800103016.jpg' },
    { name: 'ЛДСП Egger Дуб Галифакс глазурованный чёрный H3178 ST37 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Галифакс глазурованный чёрный H3178 ST37 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Галифакс натуральный  Н1180 ST37 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Галифакс натуральный  Н1180 ST37 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Галифакс олово H3176 ST37 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Галифакс олово H3176 ST37 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Галифакс табак  Н1181 ST37 2800103016', path: 'textures/wood/ЛДСП Egger Дуб Галифакс табак  Н1181 ST37 2800103016.jpg' },
    { name: 'ЛДСП Egger Дуб Гамильтон натуральный H3303 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Гамильтон натуральный H3303 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Гладстоун песочный  H3309 ST28 2800103016', path: 'textures/wood/ЛДСП Egger Дуб Гладстоун песочный  H3309 ST28 2800103016.jpg' },
    { name: 'ЛДСП Egger Дуб Гладстоун сепия H3342 ST28 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Гладстоун сепия H3342 ST28 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Гладстоун серо-бежевый Н3326 ST28 2800103016', path: 'textures/wood/ЛДСП Egger Дуб Гладстоун серо-бежевый Н3326 ST28 2800103016.jpg' },
    { name: 'ЛДСП Egger Дуб Гладстоун табак  H3325 ST28 2800103016', path: 'textures/wood/ЛДСП Egger Дуб Гладстоун табак  H3325 ST28 2800103016.jpg' },
    { name: 'ЛДСП Egger Дуб Давос натуральный Н3131 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Давос натуральный Н3131 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Давос трюфель H3133 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Давос трюфель H3133 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Денвер графит Н1387 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Денвер графит Н1387 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Денвер трюфель Н1399 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Денвер трюфель Н1399 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Канзас коричневый Н1113 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Канзас коричневый Н1113 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Кендал коньяк Н3398 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Кендал коньяк Н3398 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Кендал Натуральный Н3170 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Кендал Натуральный Н3170 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Корбридж натуральный Н3395 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Корбридж натуральный Н3395 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Лоренцо бежево-серый H3146 ST19 2800_2070_16', path: 'textures/wood/ЛДСП Egger Дуб Лоренцо бежево-серый H3146 ST19 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Дуб Орлеанский коричневый Н1379 ST36 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Орлеанский коричневый Н1379 ST36 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Санта-Фе винтаж Н1330 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Санта-Фе винтаж Н1330 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Сорано натуральный светлый Н1334 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Сорано натуральный светлый Н1334 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Сорано черно-коричневый Н1137 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Сорано черно-коричневый Н1137 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб термо чёрно-коричневый Н1199 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Дуб термо чёрно-коричневый Н1199 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб термо чёрно-коричневый Н1199 ST12 2800_2070_16', path: 'textures/wood/ЛДСП Egger Дуб термо чёрно-коричневый Н1199 ST12 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Дуб Уайт-Ривер песочно-бежевый Н1312 ST10 2800_2070_16', path: 'textures/wood/ЛДСП Egger Дуб Уайт-Ривер песочно-бежевый Н1312 ST10 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Дуб Уайт-Ривер серо-коричневый Н1313 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Уайт-Ривер серо-коричневый Н1313 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Чарльстон темно-коричневый Н3154 ST36  2800207016', path: 'textures/wood/ЛДСП Egger Дуб Чарльстон темно-коричневый Н3154 ST36  2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Шерман коньяк коричневый Н1344 ST32 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Шерман коньяк коричневый Н1344 ST32 2800207016.jpg' },
    { name: 'ЛДСП Egger Дуб Шерман серый Н1345 ST32 2800207016', path: 'textures/wood/ЛДСП Egger Дуб Шерман серый Н1345 ST32 2800207016.jpg' },
    { name: 'ЛДСП Egger Желтый бриллиант U114 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Желтый бриллиант U114 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Зебрано песочно-бежевый Н3006 ST22  2800_2070_16', path: 'textures/wood/ЛДСП Egger Зебрано песочно-бежевый Н3006 ST22  2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Зелёный изумрудный  U655 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Зелёный изумрудный  U655 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Зелёный киви U626 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Зелёный киви U626 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Зелёный лес U606 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Зелёный лес U606 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Зеленый лайм U630 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Зеленый лайм U630 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Камель бежевый U216 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Камель бежевый U216 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Камень Пьетра Гриджиа чёрный F206 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Камень Пьетра Гриджиа чёрный F206 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Кашемир серый U702 ST16 2800207016', path: 'textures/wood/ЛДСП Egger Кашемир серый U702 ST16 2800207016.jpg' },
    { name: 'ЛДСП Egger Кашемир серый U702 ST9 2800_2070_16', path: 'textures/wood/ЛДСП Egger Кашемир серый U702 ST9 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Клён сахарный шампань Н3860 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Клён сахарный шампань Н3860 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Клен мандал натуральный Н3840 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Клен мандал натуральный Н3840 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Кокоболо натуральный Н3012 ST22  2800207016', path: 'textures/wood/ЛДСП Egger Кокоболо натуральный Н3012 ST22  2800207016.jpg' },
    { name: 'ЛДСП Egger Коттон бежевый U113 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Коттон бежевый U113 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Красный китайский  U321 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Красный китайский  U321 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Крем бежевый U222 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Крем бежевый U222 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Кубанит серый U767 SТ9 2800207016', path: 'textures/wood/ЛДСП Egger Кубанит серый U767 SТ9 2800207016.jpg' },
    { name: 'ЛДСП Egger Лён антрацит F433 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Лён антрацит F433 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Лава Серая  U741 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Лава Серая  U741 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Лен бежевый F425 ST10 2800_2070_16', path: 'textures/wood/ЛДСП Egger Лен бежевый F425 ST10 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Лес Черный  U998 ST38 2800207016', path: 'textures/wood/ЛДСП Egger Лес Черный  U998 ST38 2800207016.jpg' },
    { name: 'ЛДСП Egger Лес Черный U998 ST38 2800_2070_16', path: 'textures/wood/ЛДСП Egger Лес Черный U998 ST38 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Лиственница горная коричневая термо H3408 ST38 2800207016', path: 'textures/wood/ЛДСП Egger Лиственница горная коричневая термо H3408 ST38 2800207016.jpg' },
    { name: 'ЛДСП Egger Макассар мокка Н1101 ST12 2800_2070_16', path: 'textures/wood/ЛДСП Egger Макассар мокка Н1101 ST12 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Махагон Н3080 ST15 2800_2070_16', path: 'textures/wood/ЛДСП Egger Махагон Н3080 ST15 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Металлик золото F571 ST2 2800_2070_16', path: 'textures/wood/ЛДСП Egger Металлик золото F571 ST2 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Металлик медь F570 ST2 2800_2070_16', path: 'textures/wood/ЛДСП Egger Металлик медь F570 ST2 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Металлик Файнлайн антрацит H3190 ST19 2800_2070_16', path: 'textures/wood/ЛДСП Egger Металлик Файнлайн антрацит H3190 ST19 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Металлик Файнлайн коричневый Н3192 ST19 2800_2070_16', path: 'textures/wood/ЛДСП Egger Металлик Файнлайн коричневый Н3192 ST19 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Мрамор Каррара белый F204 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Мрамор Каррара белый F204 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Нежный черный U899 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Нежный черный U899 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Оникс серый U960 ST9  2800207016', path: 'textures/wood/ЛДСП Egger Оникс серый U960 ST9  2800207016.jpg' },
    { name: 'ЛДСП Egger Оранжевый U332 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Оранжевый U332 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех Аида Табак H3704 ST15 2800_2070_16', path: 'textures/wood/ЛДСП Egger Орех Аида Табак H3704 ST15 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Орех Дижон натуральный H3734 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Орех Дижон натуральный H3734 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех Карини натуральный H3710 ST12 2800207016', path: 'textures/wood/ЛДСП Egger Орех Карини натуральный H3710 ST12 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех Карини табак Н3711 ST9 2800_2070_16', path: 'textures/wood/ЛДСП Egger Орех Карини табак Н3711 ST9 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Орех Линкольн H1714 ST19 2800207016', path: 'textures/wood/ЛДСП Egger Орех Линкольн H1714 ST19 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех Пацифик натуральный H3700 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Орех Пацифик натуральный H3700 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех пацифик табак H3702 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Орех пацифик табак H3702 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Орех пацифик табак H3702 ST10 2800_2070_16', path: 'textures/wood/ЛДСП Egger Орех пацифик табак H3702 ST10 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Орех Рибера Н1114 ST9 2800_2070_16', path: 'textures/wood/ЛДСП Egger Орех Рибера Н1114 ST9 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Пихта Брамберг Н1487 ST22  2800207016', path: 'textures/wood/ЛДСП Egger Пихта Брамберг Н1487 ST22  2800207016.jpg' },
    { name: 'ЛДСП Egger Робиния Брэнсон натуральная коричневая H1251 ST19 2800207016', path: 'textures/wood/ЛДСП Egger Робиния Брэнсон натуральная коричневая H1251 ST19 2800207016.jpg' },
    { name: 'ЛДСП Egger Розовый антик  U325 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Розовый антик  U325 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Светло-Серый U708 ST9 2800103016', path: 'textures/wood/ЛДСП Egger Светло-Серый U708 ST9 2800103016.jpg' },
    { name: 'ЛДСП Egger Серая галька U201 ST19 2800207016', path: 'textures/wood/ЛДСП Egger Серая галька U201 ST19 2800207016.jpg' },
    { name: 'ЛДСП Egger Серая галька U201 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Серая галька U201 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Серый камень U727 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Серый камень U727 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Серый Перламутровый U763 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Серый Перламутровый U763 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Серый пыльный U732 ST30ST2 2800207016', path: 'textures/wood/ЛДСП Egger Серый пыльный U732 ST30ST2 2800207016.jpg' },
    { name: 'ЛДСП Egger Серый пыльный U732 ST9', path: 'textures/wood/ЛДСП Egger Серый пыльный U732 ST9.jpg' },
    { name: 'ЛДСП Egger Серый пыльный глянец U732 ST30_ST30 2800_2070_16', path: 'textures/wood/ЛДСП Egger Серый пыльный глянец U732 ST30_ST30 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Серый уголь U968 ST9  2800207016', path: 'textures/wood/ЛДСП Egger Серый уголь U968 ST9  2800207016.jpg' },
    { name: 'ЛДСП Egger Синяя глубина U560 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Синяя глубина U560 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Сосна Аланд белая Н3430 ST22 2800103016', path: 'textures/wood/ЛДСП Egger Сосна Аланд белая Н3430 ST22 2800103016.jpg' },
    { name: 'ЛДСП Egger Сосна Аланд полярная Н3433 ST22 2800103016', path: 'textures/wood/ЛДСП Egger Сосна Аланд полярная Н3433 ST22 2800103016.jpg' },
    { name: 'ЛДСП Egger Сосна Альпийская Н1444 ST9 2800_2070_16', path: 'textures/wood/ЛДСП Egger Сосна Альпийская Н1444 ST9 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Сосна Гавана белая Н3078 ST22 2800_2070_16', path: 'textures/wood/ЛДСП Egger Сосна Гавана белая Н3078 ST22 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Сосна Гавана черная Н3081 ST22 2800_2070_16', path: 'textures/wood/ЛДСП Egger Сосна Гавана черная Н3081 ST22 2800_2070_16.jpg' },
    { name: 'ЛДСП Egger Сосна Касцина Н1401 ST22 2800103016', path: 'textures/wood/ЛДСП Egger Сосна Касцина Н1401 ST22 2800103016.jpg' },
    { name: 'ЛДСП Egger Сосна Пасадена Н1486 ST36  2800103016', path: 'textures/wood/ЛДСП Egger Сосна Пасадена Н1486 ST36  2800103016.jpg' },
    { name: 'ЛДСП Egger Тёмно-коричневый  U818 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Тёмно-коричневый  U818 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Текстиль Бежевый F416 ST10 2800207016', path: 'textures/wood/ЛДСП Egger Текстиль Бежевый F416 ST10 2800207016.jpg' },
    { name: 'ЛДСП Egger Трюфель Коричневый  U748 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Трюфель Коричневый  U748 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Фанлайн крем Н1424 ST22 2800207016', path: 'textures/wood/ЛДСП Egger Фанлайн крем Н1424 ST22 2800207016.jpg' },
    { name: 'ЛДСП Egger Ферро Бронза F302 ST87 2800207016', path: 'textures/wood/ЛДСП Egger Ферро Бронза F302 ST87 2800207016.jpg' },
    { name: 'ЛДСП Egger Фламинго розовый U363 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Фламинго розовый U363 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Флитвуд Белый Н3450 ST22 2800207016', path: 'textures/wood/ЛДСП Egger Флитвуд Белый Н3450 ST22 2800207016.jpg' },
    { name: 'ЛДСП Egger Флитвуд серая лава Н3453 ST22 2800207016', path: 'textures/wood/ЛДСП Egger Флитвуд серая лава Н3453 ST22 2800207016.jpg' },
    { name: 'ЛДСП Egger Флитвуд шампань Н3451 ST22 2800207016', path: 'textures/wood/ЛДСП Egger Флитвуд шампань Н3451 ST22 2800207016.jpg' },
    { name: 'ЛДСП Egger Фуксия розовая U337 ST9 2800207016', path: 'textures/wood/ЛДСП Egger Фуксия розовая U337 ST9 2800207016.jpg' },
    { name: 'ЛДСП Egger Хромикс белый F637 ST16 2800207016', path: 'textures/wood/ЛДСП Egger Хромикс белый F637 ST16 2800207016.jpg' }
];

// Утилиты для красивого форматирования чисел
const mm = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
const dimensionText = (values) => values.map(mm).join(' × ');
const sizeLabel = (bytes) => new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(bytes / 1024) + ' КБ';

// ==========================================
// 3. НАСТРОЙКИ РЕНДЕРА (СВЕТ, ТЕНИ, КАЧЕСТВО)
// ==========================================

// Значения по умолчанию для всех ползунков рендера
const renderDefaults = {
    quality: 1, mode: 'solid', flat: false, ambient: 1.1, key: 0.85,
    fill: 0.3, angle: 40, tone: 'none', exposure: 1, shadows: false,
    shadowQuality: 1024, roughness: 0.8, background: '#ffffff', fov: 38
};

// Пресеты (Быстрый, Обычный, Студия)
const renderPresets = {
    fast: { ...renderDefaults, quality: 0.75, shadowQuality: 512 },
    balanced: { ...renderDefaults },
    studio: {
        ...renderDefaults, quality: 2, ambient: 0.7, key: 1.5, fill: 0.5,
        tone: 'aces', exposure: 1.15, shadows: true, shadowQuality: 2048, roughness: 0.65
    }
};

let renderSettings = { ...renderDefaults };

/**
 * Нормализует настройки рендера (обрезает значения по допустимым диапазонам).
 * Нужна для защиты от некорректных данных из localStorage или UI.
 */
function normalizeRenderSettings(value) {
    const result = { ...renderDefaults };
    if (!value || typeof value !== 'object') return result;
    
    // Ограничиваем числовые значения
    const ranges = {
        ambient: [0, 2], key: [0, 3], fill: [0, 2], angle: [0, 360],
        exposure: [0.3, 2], roughness: [0.05, 1], fov: [20, 75]
    };
    for (const [key, range] of Object.entries(ranges))
        if (typeof value[key] === 'number' && Number.isFinite(value[key]))
            result[key] = Math.max(range[0], Math.min(range[1], value[key]));
            
    // Проверяем, что строковые значения входят в допустимый список
    for (const [key, values] of Object.entries({
        quality: [0.75, 1, 1.5, 2], shadowQuality: [512, 1024, 2048],
        mode: ['solid', 'wireframe'], tone: ['none', 'aces', 'reinhard']
    }))
        if (values.includes(value[key])) result[key] = value[key];
        
    // Проверяем булевы значения и HEX-цвет
    for (const key of ['flat', 'shadows']) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background))
        result.background = value.background;
    return result;
}

/**
 * Синхронизирует UI (ползунки, чекбоксы) с текущими значениями renderSettings.
 */
function syncRenderControls() {
    for (const key of Object.keys(renderDefaults)) {
        const id = key === 'shadowQuality' ? 'shadow-quality' : key;
        const field = $('render-' + id);
        if (typeof renderDefaults[key] === 'boolean') field.checked = renderSettings[key];
        else field.value = String(renderSettings[key]);
    }
    // Обновляем подписи значений рядом с ползунками
    for (const key of ['ambient', 'key', 'fill', 'angle', 'exposure', 'roughness', 'fov'])
        $('render-' + key + '-value').textContent = mm(renderSettings[key]) + (key === 'angle' || key === 'fov' ? '°' : '');
    $('render-exposure').disabled = renderSettings.tone === 'none';
    $('render-shadow-quality').disabled = !renderSettings.shadows;
    // Подсвечиваем активный пресет
    for (const [name, preset] of Object.entries(renderPresets))
        $('render-' + name).setAttribute('aria-pressed', String(Object.keys(renderDefaults).every((key) => preset[key] === renderSettings[key])));
}

/**
 * Применяет настройки рендера к сцене Three.js (свет, тени, камера).
 * Вызывается при изменении любого ползунка или пресета.
 */
function applyRenderSettings() {
    syncRenderControls();
    $('canvas').style.background = renderSettings.background;
    if (!engine) return;
    
    const { renderer, camera, scene, ambient, light, fill } = engine;
    const previous = engine.appliedRenderSettings || {};
    
    // Качество (pixel ratio)
    if (previous.quality !== renderSettings.quality) renderer.setPixelRatio(renderSettings.quality);
    
    // Размер и пропорции камеры
    const width = $('canvas').clientWidth, height = $('canvas').clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.fov = renderSettings.fov;
    camera.updateProjectionMatrix();
    
    // Тональная обработка (Tone Mapping)
    renderer.toneMapping = { none: THREE.NoToneMapping, aces: THREE.ACESFilmicToneMapping, reinhard: THREE.ReinhardToneMapping }[renderSettings.tone];
    renderer.toneMappingExposure = renderSettings.exposure;
    
    // Тени
    renderer.shadowMap.enabled = renderSettings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    ambient.intensity = renderSettings.ambient;
    light.intensity = renderSettings.key;
    fill.intensity = renderSettings.fill;
    light.castShadow = renderSettings.shadows && renderSettings.mode === 'solid';
    
    // Настройка размера теневой карты
    const shadowSize = Math.min(renderSettings.shadowQuality, renderer.capabilities.maxTextureSize);
    if (light.shadow.mapSize.x !== shadowSize || !renderSettings.shadows) {
        light.shadow.mapSize.set(shadowSize, shadowSize);
        if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; }
    }
    
    // Пересчет позиции света и тени относительно габаритов модели
    if (model) {
        const center = model.bounds.getCenter(new THREE.Vector3()), size = model.bounds.getSize(new THREE.Vector3()), radius = Math.max(1, size.length() / 2);
        const angle = (renderSettings.angle * Math.PI) / 180;
        light.position.set(center.x + Math.sin(angle) * radius * 2, center.y + radius * 3, center.z + Math.cos(angle) * radius * 2);
        light.target.position.copy(center);
        fill.position.copy(center).add(new THREE.Vector3(-radius * 2, radius, -radius));
        
        // Настройка теневой камеры (чтобы тени не были обрезаны)
        const shadowCamera = light.shadow.camera;
        shadowCamera.left = shadowCamera.bottom = -radius * 1.5;
        shadowCamera.right = shadowCamera.top = radius * 1.5;
        const lightDistance = light.position.distanceTo(center);
        shadowCamera.near = Math.max(0.1, lightDistance - radius * 1.75);
        shadowCamera.far = lightDistance + radius * 2;
        shadowCamera.updateProjectionMatrix();
        
        // Сглаживание теней (bias)
        const shadowTexel = (radius * 3) / shadowSize;
        light.shadow.bias = -0.0003;
        light.shadow.normalBias = Math.min(2, Math.max(0.05, shadowTexel * 0.15));
        
        // Невидимая плоскость для принятия теней
        if (renderSettings.shadows && !engine.shadowFloor) {
            engine.shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false }));
            engine.shadowFloor.rotation.x = -Math.PI / 2;
            engine.shadowFloor.receiveShadow = true;
            scene.add(engine.shadowFloor);
        }
        if (engine.shadowFloor) {
            engine.shadowFloor.position.set(center.x, model.bounds.min.y - 0.5, center.z);
            engine.shadowFloor.scale.set(radius * 5, radius * 5, 1);
            engine.shadowFloor.visible = renderSettings.shadows && renderSettings.mode === 'solid';
        }
        
        // Применение настроек к материалам панелей
        for (const panel of model.panels) {
            panel.material.wireframe = renderSettings.mode === 'wireframe';
            panel.material.flatShading = renderSettings.flat;
            panel.material.roughness = renderSettings.roughness;
            if (['mode', 'flat', 'tone', 'shadows'].some((key) => previous[key] !== renderSettings[key]) || engine.appliedModel !== model)
                panel.material.needsUpdate = true;
            panel.receiveShadow = renderSettings.shadows;
            panel.castShadow = renderSettings.shadows && !panel.material.transparent;
        }
    }
    
    engine.appliedRenderSettings = { ...renderSettings };
    engine.appliedModel = model;
    scene.updateMatrixWorld(true);
    render();
}

// ==========================================
// 4. 3D КУБ НАВИГАЦИИ (VIEWCUBE)
// ==========================================

/**
 * Создает интерактивный 3D-куб в правой панели для быстрого переключения видов.
 */
function initializeViewCube() {
    const cube = $('view-cube');
    const faces = [
        ['front', 'Спереди', [0, 0, 1]], ['back', 'Сзади', [0, 0, -1]],
        ['right', 'Справа', [1, 0, 0]], ['left', 'Слева', [-1, 0, 0]],
        ['top', 'Сверху', [0, 1, 0]], ['bottom', 'Снизу', [0, -1, 0]]
    ];
    
    function navigate(direction) {
        if (!model) return;
        const vector = new THREE.Vector3(...direction);
        if (!vector.x && !vector.z) vector.z = 0.0001;
        fit(vector.normalize());
    }
    
    for (const [face, label, direction] of faces) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cube-face cube-' + face;
        button.textContent = label;
        button.title = label;
        button.setAttribute('aria-label', 'Вид ' + label.toLocaleLowerCase());
        button.onclick = () => navigate(direction);
        cube.append(button);
    }
    
    for (const x of [-1, 1])
        for (const y of [-1, 1])
            for (const z of [-1, 1]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'cube-corner';
                const label = 'Объёмный вид: ' + (y > 0 ? 'сверху' : 'снизу') + ', ' + (x > 0 ? 'справа' : 'слева') + ', ' + (z > 0 ? 'спереди' : 'сзади');
                button.title = label;
                button.setAttribute('aria-label', label);
                button.style.transform = `translate3d(${x * 38}px,${-y * 38}px,${z * 38}px)`;
                button.onclick = () => navigate([x, y, z]);
                cube.append(button);
            }
    updateViewCube();
}

/**
 * Обновляет поворот 3D-куба в соответствии с текущим поворотом камеры.
 */
function updateViewCube() {
    if (!window.THREE) return;
    const rotation = engine
        ? engine.camera.quaternion.clone()
        : new THREE.Quaternion().setFromRotationMatrix(
              new THREE.Matrix4().lookAt(new THREE.Vector3(1, 0.65, 1.8), new THREE.Vector3(), new THREE.Vector3(0, 1, 0))
          );
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation.invert());
    const signs = [1, -1, 1, 1];
    const values = matrix.elements.map((value, index) => value * signs[index % 4] * signs[Math.floor(index / 4)]);
    $('view-cube').style.transform = 'matrix3d(' + values.join(',') + ')';
}

// ==========================================
// 5. ИНИЦИАЛИЗАЦИЯ 3D-СЦЕНЫ
// ==========================================

/**
 * Обновляет параметры проекции камеры при изменении размера окна.
 */
function updateCameraProjection() {
    const camera = engine.camera;
    camera.aspect = Math.max(1, $('canvas').clientWidth) / Math.max(1, $('canvas').clientHeight);
    camera.fov = renderSettings.fov;
    if (camera.isOrthographicCamera) {
        const halfHeight = Math.max(0.01, camera.position.distanceTo(engine.controls.target)) * Math.tan((camera.fov * Math.PI) / 360);
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.right = halfHeight * camera.aspect;
        camera.left = -camera.right;
    }
    camera.updateProjectionMatrix();
}

/**
 * Переключает камеру между перспективной и ортографической проекцией.
 */
function setPerspective(enabled) {
    $('perspective').checked = enabled;
    if (!engine || Boolean(engine.camera.isPerspectiveCamera) === enabled) return;
    
    const previous = engine.camera;
    const camera = enabled
        ? new THREE.PerspectiveCamera(renderSettings.fov, previous.aspect, previous.near, previous.far)
        : new THREE.OrthographicCamera(-1, 1, 1, -1, previous.near, previous.far);
        
    camera.position.copy(previous.position);
    camera.quaternion.copy(previous.quaternion);
    camera.up.copy(previous.up);
    if (enabled) camera.position.sub(engine.controls.target).divideScalar(previous.zoom).add(engine.controls.target);
    
    engine.camera = camera;
    engine.controls.object = camera;
    updateCameraProjection();
    engine.controls.update();
    clearHover();
    render();
}

/**
 * Создает и настраивает сцену Three.js, камеру, свет и рендерер.
 * Вызывается один раз при загрузке первой модели.
 */
function initialize3D() {
    if (engine) return engine;
    
    // Проверка, что все необходимые библиотеки загружены
    if (!window.THREE || !THREE.OrbitControls || !window.pako || !window.BazisB3D || !window.BazisScene || !window.BazisCuts || !window.BazisHardware)
        throw new Error('Не загрузились JS-файлы. Скопируйте папку vendor, b3d-parser.js, b3d-cuts.js, b3d-hardware.js и b3d-scene.js.');
        
    // Настройка рендерера
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.className = 'webgl-view';
    $('canvas').prepend(renderer.domElement);
    
    // Сцена и камера
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 1, 100000);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    
    // Освещение (имитация студийного)
    const ambient = new THREE.HemisphereLight(0xffffff, 0x727c8a, 1.1);
    scene.add(ambient);
    const light = new THREE.DirectionalLight(0xffffff, 0.85);
    light.position.set(2000, 3500, 4000);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xb9d5ff, 0.3);
    fill.position.set(-2500, 1000, -1000);
    scene.add(fill);
    scene.add(light.target);
    
    // Сохраняем все в объект engine для быстрого доступа
    engine = { renderer, scene, camera, controls, ambient, light, fill, baseDistance: 1, grid: null, selectionBox: null, shadowFloor: null };
    
    // При вращении камеры закрываем меню и убираем подсветку
    controls.addEventListener('change', () => { closePartMenu(); clearHover(); render(); });
    
    // Обработка изменения размера окна
    const resize = () => {
        const w = $('canvas').clientWidth, h = $('canvas').clientHeight;
        renderer.setSize(w, h);
        updateCameraProjection();
        render();
    };
    resize();
    new ResizeObserver(resize).observe($('canvas'));
    
    applyRenderSettings();
    installPointerInteractions(renderer.domElement, controls);
    setPerspective($('perspective').checked);
    return engine;
}
// ==========================================
// 4. ОБРАБОТКА МЫШИ И КЛИКОВ
// ==========================================

/**
 * Навешивает обработчики событий мыши и тач-экрана на canvas.
 * Обрабатывает вращение камеры, выделение деталей, вызов контекстного меню и режим измерений.
 */
function installPointerInteractions(element, controls) {
    const pointers = new Set();
    let down = null,
        timer = null;

    // Останавливает таймер долгого нажатия (для вызова меню на телефонах)
    const stopTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };

    // Нажатие кнопки мыши или касание экрана
    element.addEventListener('pointerdown', (event) => {
        stopTimer();
        pointers.add(event.pointerId);

        // Если нажали несколько пальцев одновременно (мультитач)
        if (pointers.size > 1) {
            if (down) down.moved = true;
            clearHover();
            return;
        }

        // Запоминаем начальную точку нажатия
        down = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            button: event.button,
            touch: event.pointerType === 'touch',
            moved: false,
            held: false
        };

        try {
            element.setPointerCapture(event.pointerId);
        } catch (_) {}

        // Долгое нажатие на тач-экранах (имитация правой кнопки мыши)
        if (down.touch && tool === 'select')
            timer = setTimeout(() => {
                if (!down || down.moved || pointers.size !== 1) return;
                const hit = pick(event);
                if (hit) {
                    down.held = true;
                    openPartMenu(hit.object, event);
                    controls.enabled = false;
                }
            }, 550);
    });

    // Движение мыши (или пальца)
    element.addEventListener('pointermove', (event) => {
        // Если мышь сдвинулась больше чем на 4 пикселя — это уже не клик, а вращение
        if (down && event.pointerId === down.id && Math.hypot(event.clientX - down.x, event.clientY - down.y) > (down.touch ? 8 : 4)) {
            down.moved = true;
            stopTimer();
        }

        // Логика подсветки привязок (только в режиме измерений)
        if (pointers.size || tool !== 'measure' || !model || event.buttons) {
            if (hoverGraphic) {
                clearHover();
                render();
            }
            return;
        }

        const hit = pick(event);
        if (!hit) {
            if (hoverGraphic) {
                clearHover();
                render();
            }
            $('snap-status').textContent = 'Наведите курсор на поверхность детали';
            return;
        }
        showSnapPreview(snapPoint(hit, event), event);
    });

    // Отпускание кнопки мыши (или пальца)
    element.addEventListener('pointerup', (event) => {
        stopTimer();
        pointers.delete(event.pointerId);
        controls.enabled = true;

        const gesture = down;
        if (!pointers.size) down = null;

        // Если это был не клик, а перетаскивание или мультитач — игнорируем
        if (!gesture || gesture.id !== event.pointerId || gesture.moved || gesture.held || pointers.size || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > (gesture.touch ? 8 : 4)) return;

        const hit = pick(event);

        // Правая кнопка мыши (контекстное меню)
        if (gesture.button === 2) {
            openPartMenu(hit ? hit.object : null, event);
            return;
        }

        if (!model) return;
        if (gesture.button !== 0) return;

        // Режим выбора светящейся грани для LED
        if (choosingLightFace) {
            if (!hit) return;
            if (hit.object !== highlighted) {
                $('light-status').textContent = 'Нажмите на грань выбранной детали.';
                return;
            }
            const normal = hit.face.normal.clone();
            if (hit.object.userData.localMatrix)
                normal.transformDirection(hit.object.userData.localMatrix.clone().invert());
            for (const panel of lightTargets()) {
                panel.userData.light = { ...defaultLight, ...panel.userData.light, face: normal.toArray() };
                panel.userData.glow = true;
            }
            choosingLightFace = false;
            $('canvas').classList.remove('choosing-light-face');
            updateColorControls();
            render();
            return;
        }

        // Режим измерений (добавляем точку) или обычный выбор детали
        if (tool === 'measure') {
            if (hit) addMeasurementPoint(snapPoint(hit, event));
            else $('snap-status').textContent = 'Нажмите на поверхность детали.';
        } else {
            selectPart(hit ? hit.object : null, event.shiftKey);
            if (hit && !['materials', 'render', 'tree'].includes(activeTab)) openTab('parts');
        }
    });

    // Отмена нажатия (например, если палец ушел за пределы экрана)
    element.addEventListener('pointercancel', (event) => {
        stopTimer();
        pointers.delete(event.pointerId);
        if (down) down.moved = true;
        if (!pointers.size) down = null;
        controls.enabled = true;
    });

    // Отключаем стандартное контекстное меню браузера по правой кнопке
    element.addEventListener('contextmenu', (event) => event.preventDefault());
    
    // Если курсор ушел с холста — сбрасываем подсветку
    element.addEventListener('pointerleave', () => {
        if (!pointers.size) {
            clearHover();
            render();
        }
    });
}

// ==========================================
// 5. ФУРНИТУРА И ВЫДЕЛЕНИЕ
// ==========================================
let renderPending = false;
let contactModel = null,
    contactPart = null,
    contactContours = new Set();

/**
 * Скрывает или показывает контуры фурнитуры, которые касаются выделенной панели.
 */
function updateSelectionHardware() {
    if (!model) return;
    const part = $('selection-hardware').checked && highlighted && !highlighted.userData.isHardware ? highlighted : null;
    
    if (model !== contactModel || part !== contactPart) {
        contactModel = model;
        contactPart = part;
        contactContours = new Set();
        
        if (part) {
            const inverse = part.userData.localMatrix.clone().invert();
            const localGeometry = part.geometry.clone().applyMatrix4(inverse);
            localGeometry.computeBoundingBox();
            const bounds = localGeometry.boundingBox.clone().expandByScalar(0.3);
            localGeometry.dispose();
            const ray = new THREE.Ray(), hit = new THREE.Vector3();
                
            // Проверяем, какие контуры фурнитуры физически касаются выбранной панели
            for (const contour of model.hardware.children) {
                if (contour.isMesh) continue; // 3D-цилиндры проверяются по ID панели
                const positions = contour.geometry?.attributes.position;
                if (!positions) continue;
                for (let i = 0; i + 1 < positions.count; i += 2) {
                    const a = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(inverse);
                    const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1).applyMatrix4(inverse);
                    if (bounds.containsPoint(a) || bounds.containsPoint(b)) {
                        contactContours.add(contour);
                        break;
                    }
                    const direction = b.clone().sub(a), length = direction.length();
                    if (!length) continue;
                    ray.set(a, direction.divideScalar(length));
                    if (ray.intersectBox(bounds, hit) && hit.distanceTo(a) <= length) {
                        contactContours.add(contour);
                        break;
                    }
                }
            }
        }
    }

    const showAllContours = $('hardware').checked && !isolated;
    const selectedIds = new Set();
    if (highlighted) selectedIds.add(highlighted.userData.treeNodeId);
    if (highlightedGroup) [...highlightedGroup.parts].forEach(p => selectedIds.add(p.userData.treeNodeId));

    let visible = false;
    for (const child of model.hardware.children) {
        let isContact = contactContours.has(child);
        
        if (!isContact && child.userData.treeNodeId && selectedIds.has(child.userData.treeNodeId)) {
            isContact = true;
        }
        
        child.visible = showAllContours || isContact;
        
        if (child.material) {
            if (isContact) {
                child.material.depthTest = false; // Показываем поверх панели
                child.renderOrder = 10;
                if (child.material.emissive) child.material.emissive.setHex(0x263e0a); // Зеленая подсветка
            } else {
                child.material.depthTest = true;
                child.renderOrder = 3;
                if (child.material.emissive && !child.userData.glow) {
                    child.material.emissive.setHex(0x000000); // Убираем подсветку
                }
            }
        }
        visible ||= child.visible;
    }
    model.hardware.visible = visible;
}

// ==========================================
// 6. ГЛАВНЫЙ ЦИКЛ ОТРИСОВКИ
// ==========================================

/**
 * Запускает отрисовку кадра. Использует requestAnimationFrame, чтобы не рисовать лишний раз.
 */
function render() {
    if (!engine || renderPending) return;
    renderPending = true;
    window.requestAnimationFrame(() => {
        renderPending = false;
        renderFrame();
    });
}

/**
 * Основная функция отрисовки одного кадра.
 * Обновляет подсветку, камеру, зум, измерения и вызывает renderer.render().
 */
function renderFrame() {
    if (!engine) return;
    updateSelectionHardware();
    updateCameraProjection();
    updateViewCube();
    if (model) for (const panel of model.panels) updateMaterialGlow(panel);
    updateLEDLights();
    
    // Динамическая настройка ближней и дальней плоскости отсечения камеры (z-fighting)
    if (model) {
        const radius = Math.max(1, model.bounds.getSize(new THREE.Vector3()).length() / 2);
        const distance = engine.camera.position.distanceTo(model.bounds.getCenter(new THREE.Vector3()));
        const focusDistance = engine.camera.position.distanceTo(engine.controls.target);
        const near = Math.max(0.1, Math.min(focusDistance * 0.005, radius * 0.005));
        const far = Math.max(near * 10, distance + radius * (renderSettings.shadows ? 5 : 2.5));
        if (engine.camera.near !== near || engine.camera.far !== far) {
            engine.camera.near = near;
            engine.camera.far = far;
            engine.camera.updateProjectionMatrix();
        }
    }
    
    // Обновление статистики WebGL внизу панели
    if (engine.renderer.info) {
        const stats = engine.renderer.info.render,
            pixels = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
        $('render-info').textContent = 'WebGL ' + (engine.renderer.capabilities.isWebGL2 ? '2' : '1') + ' · ' + pixels.x + ' × ' + pixels.y + ' px · ' + stats.calls + ' вызовов · ' + new Intl.NumberFormat('ru-RU').format(stats.triangles) + ' треугольников';
    }
    
    // Обновление процента зума
    if (model)
        $('zoom').textContent = Math.round((engine.baseDistance / engine.camera.position.distanceTo(engine.controls.target)) * engine.camera.zoom * 100) + '%';

    // Обновление позиций текстовых меток измерений
    engine.camera.updateMatrixWorld(true);
    for (const measurement of measurements) {
        const point = measurement.a.clone().add(measurement.b).multiplyScalar(0.5).project(engine.camera);
        measurement.label.hidden = point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
        measurement.label.style.left = ((point.x + 1) / 2) * $('canvas').clientWidth + 'px';
        measurement.label.style.top = ((1 - point.y) / 2) * $('canvas').clientHeight + 'px';
        const distance = engine.camera.position.distanceTo(engine.controls.target);
        const scale = Math.max(0.55, Math.min(1.3, (engine.baseDistance * engine.camera.zoom) / Math.max(1, distance)));
        measurement.label.style.transform = 'translate(-50%,-50%) scale(' + scale + ')';
        measurement.graphic.traverse((object) => {
            if (object.isPoints) object.material.size = 6 * scale;
        });
    }

    // Обновление инструментов сечений и дерева модели
    sectionTools.render();
    treeTools.sync();
    
    // Блокировка кнопок в зависимости от состояния
    $('header-show-all').disabled = !model || !model.panels.some((panel) => !panel.visible);
    $('header-focus').disabled = !model || (!highlighted && !highlightedGroup);
    
    // Финальная отрисовка сцены
    engine.renderer.render(engine.scene, engine.camera);
    
    // Счетчик FPS
    if (!fpsPending) {
        fpsPending = true;
        window.requestAnimationFrame(() => {
            fpsFrames++;
            fpsPending = false;
        });
    }
}

/**
 * Удаляет объект из сцены и освобождает память (геометрию и материалы).
 */
function disposeObject(object) {
    if (!object || !engine) return;
    engine.scene.remove(object);
    object.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
}

/**
 * Определяет, по какому объекту кликнул пользователь (Raycasting).
 * Возвращает информацию о пересечении (hit) или null.
 */
function pick(event) {
    if (!model) return null;
    const rect = engine.renderer.domElement.getBoundingClientRect(),
        ray = new THREE.Raycaster();
    ray.setFromCamera(
        new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1
        ),
        engine.camera
    );
    return (
        ray
            .intersectObjects(model.panels.filter((panel) => panel.visible))
            .find((hit) => sectionTools.isVisible(hit.point)) || null
    );
}

// ==========================================
// 7. КОНТЕКСТНОЕ МЕНЮ И ВЫДЕЛЕНИЕ ДЕТАЛЕЙ
// ==========================================

/**
 * Скрывает контекстное меню и сбрасывает ссылку на деталь.
 */
function closePartMenu() {
    $('part-menu').hidden = true;
    contextPart = null;
}

/**
 * Открывает контекстное меню (ПКМ по детали) и позиционирует его на экране.
 */
function openPartMenu(part, event) {
    if (!part || !highlightedGroup?.parts.has(part)) selectPart(part);
    contextPart = part;
    
    // Блокируем кнопки, если действие невозможно
    for (const id of ['hide-part', 'context-isolate', 'context-focus']) $(id).disabled = !part;
    $('context-drawing').disabled = !part || Boolean(part.userData.isHardware) || highlightedGroup?.parts.size > 1;
    $('context-show-all').disabled = !model || !model.panels.some((panel) => !panel.visible);
    
    const menu = $('part-menu');
    menu.hidden = false;
    
    // Умное позиционирование, чтобы меню не уходило за края экрана
    const rect = $('app').getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(event.clientX - rect.left, rect.width - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY - rect.top, rect.height - menu.offsetHeight - 4)) + 'px';
}

/**
 * Скрывает деталь и сбрасывает выделение, если она была выбрана.
 */
function hidePart(part) {
    closePartMenu();
    if (!model || !part || !model.panels.includes(part)) return;
    part.visible = false;
    if (highlighted === part) selectPart(null);
    isolated = false;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = false;
    clearHover();
    render();
}

/**
 * Возвращает массив выделенных деталей (одну или группу).
 */
function selectedParts() {
    return highlightedGroup ? [...highlightedGroup.parts] : highlighted ? [highlighted] : [];
}

/**
 * Главная функция выделения детали или группы деталей.
 * @param {THREE.Mesh} part - Деталь для выделения (или null, чтобы снять выделение).
 * @param {boolean} additive - Если true, добавляет/убирает деталь из группы (Shift + клик).
 */
function selectPart(part, additive = false) {
    // Логика группового выделения (Shift + клик)
    if (additive && part) {
        const parts = new Set(selectedParts());
        if (parts.has(part)) parts.delete(part);
        else parts.add(part);

        // Если осталась одна деталь — переключаемся в обычный режим
        if (parts.size < 2) {
            selectPart([...parts][0] || null);
            return;
        }

        selectPart(null);
        highlightedGroup = { id: null, parts };
        const bounds = new THREE.Box3();
        for (const item of parts) bounds.union(new THREE.Box3().setFromObject(item));
        
        // Рисуем общую рамку вокруг группы
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);
        
        $('selected-name').textContent = 'Выбрано деталей: ' + parts.size;
        $('selected-info').textContent = 'Shift + клик - добавить или убрать деталь';
        $('part-dimensions').textContent = dimensionText(bounds.getSize(new THREE.Vector3()).toArray());
        render();
        return;
    }

    // Логика обычного выделения (одна деталь)
    highlightedGroup = null;
    if (highlighted) highlighted.material.emissive.setHex(0); // Снимаем подсветку со старой
    disposeObject(engine.selectionBox);
    engine.selectionBox = null;
    highlighted = part;
    
    for (const id of ['focus-part', 'isolate-part']) $(id).disabled = !part;
    
    if (part) {
        part.material.emissive.setHex(0x263e0a); // Подсвечиваем зеленым
        const bounds = new THREE.Box3().setFromObject(part);
        
        // Рисуем рамку вокруг выбранной детали
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);

        // Обновляем информацию в панели "Выбранная деталь"
        $('selected-name').textContent = part.name;
        $('part-position').textContent = part.userData.artPos || 'Не указана';
        $('part-dimensions').textContent = dimensionText(part.userData.dimensions);
        $('selected-info').textContent = part.userData.materialName || 'Не указан';
        $('part-layers').hidden = !part.userData.isLayered;
        $('part-layers-list').replaceChildren();

        // Если деталь многослойная (например, МДФ + пластик), показываем слои
        if (part.userData.isLayered) {
            $('part-layer-total').textContent = part.userData.layers.map((layer) => mm(layer.thickness)).join(' + ') + ' = ' + mm(part.userData.thickness) + ' мм';
            for (const layer of part.userData.layers) {
                const row = document.createElement('li');
                row.textContent = layer.name + ' · ' + mm(layer.thickness) + ' мм · ' + (layer.materialName || 'Материал не указан');
                $('part-layers-list').append(row);
            }
        }
    } else {
        // Сброс, если ничего не выбрано
        $('selected-name').textContent = 'Не выбрана';
        $('part-position').textContent = '-';
        $('part-dimensions').textContent = '-';
        $('selected-info').textContent = 'Нажмите на панель в модели';
        $('part-layers').hidden = true;
        $('part-layers-list').replaceChildren();
    }
    
    renderPositionSearch();
    updateColorControls();
    render();
}

// ==========================================
// 8. РАБОТА С ДЕРЕВОМ МОДЕЛИ
// ==========================================

/**
 * Вызывается, когда пользователь меняет видимость панелей через дерево.
 */
function treeVisibilityChanged() {
    if (!model) return;
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = !model.panels.some((panel) => !panel.visible);
    selectPart(null); // Снимаем выделение при изменении видимости
}

/**
 * Вычисляет общие габариты (Bounding Box) для группы деталей по их индексам.
 */
function treeBounds(indices) {
    const bounds = new THREE.Box3();
    for (const index of indices)
        if (model.panels[index]) bounds.union(new THREE.Box3().setFromObject(model.panels[index]));
    return bounds;
}

/**
 * Приближает камеру к группе деталей, выбранных в дереве.
 */
function focusTreeParts(indices) {
    if (!model) return;
    for (const index of indices) model.panels[index].visible = true; // Показываем их
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = !model.panels.some((panel) => !panel.visible);
    renderPositionSearch();
    const bounds = treeBounds(indices);
    if (!bounds.isEmpty()) fit(null, bounds);
}

/**
 * Выделяет группу деталей при клике по папке в дереве.
 */
function selectTreeGroup(node) {
    if (!model || !engine) return;
    selectPart(null);
    highlightedGroup = { id: node.id, parts: new Set(node.indices.map((index) => model.panels[index])) };
    const bounds = treeBounds(node.indices);
    if (!bounds.isEmpty()) {
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);
    }
    $('selected-name').textContent = node.name;
    $('selected-info').textContent = node.indices.length + ' деталей в группе';
    $('part-dimensions').textContent = dimensionText(bounds.getSize(new THREE.Vector3()).toArray());
    render();
}

// ==========================================
// 9. ПОИСК ПО ПОЗИЦИЯМ (АРТИКУЛАМ)
// ==========================================

/**
 * Ищет детали по их позиции (ArtPos).
 * Сначала ищет точное совпадение, затем — частичное.
 */
function findPartsByPosition(query) {
    if (!model) return [];
    const text = query.trim().toLocaleLowerCase();
    const positioned = model.panels.filter((panel) => Boolean(panel.userData.artPos));
    const exact = text ? positioned.filter((panel) => panel.userData.artPos.toLocaleLowerCase() === text) : [];
    
    return (
        exact.length
            ? exact
            : positioned.filter((panel) => !text || panel.userData.artPos.toLocaleLowerCase().includes(text))
    ).sort((a, b) => {
        const ap = a.userData.artPos || '', bp = b.userData.artPos || '';
        const exactA = text && ap.toLocaleLowerCase() === text,
            exactB = text && bp.toLocaleLowerCase() === text;
        if (Boolean(exactA) !== Boolean(exactB)) return exactA ? -1 : 1; // Точные совпадения выше
        return ap.localeCompare(bp, 'ru', { numeric: true }) || a.name.localeCompare(b.name, 'ru');
    });
}

/**
 * Отрисовывает список результатов поиска в панели.
 */
function renderPositionSearch() {
    const list = $('position-results');
    list.replaceChildren();
    const results = findPartsByPosition($('position-search').value || '');
    $('position-count').textContent = results.length;
    
    for (const panel of results) {
        const button = document.createElement('button');
        button.className = 'position-result' + (panel === highlighted ? ' active' : '');
        button.setAttribute('aria-pressed', String(panel === highlighted));
        
        const position = document.createElement('strong');
        position.textContent = panel.userData.artPos ? 'Поз. ' + panel.userData.artPos : 'Без позиции';
        const name = document.createElement('span');
        name.textContent = panel.name;
        const dimensions = document.createElement('small');
        dimensions.textContent = dimensionText(panel.userData.dimensions) + ' мм' + (!panel.visible ? ' · скрыта' : '');
        
        button.append(position, name, dimensions);
        button.onclick = () => {
            if (isolated) showAll();
            panel.visible = true;
            selectPart(panel);
            fit(null, new THREE.Box3().setFromObject(panel)); // Приближаем камеру
            $('show-all').disabled = !model.panels.some((item) => !item.visible);
        };
        list.append(button);
    }
    if (!results.length) {
        const empty = document.createElement('p');
        empty.className = 'help';
        empty.textContent = model ? 'Детали с такой позицией не найдены.' : 'Сначала откройте модель.';
        list.append(empty);
    }
    applyTransparency();
}

// ==========================================
// 10. ПРИВЯЗКИ (SNAP) ДЛЯ ИЗМЕРЕНИЙ
// ==========================================

/**
 * Собирает "особые" точки детали: вершины, центры граней, ребра.
 * Нужно для того, чтобы курсор "прилипал" к ним при измерении.
 */
function snapFeatures(part) {
    if (part.userData.snapFeatures) return part.userData.snapFeatures;
    
    const positions = part.geometry.attributes.position,
        index = part.geometry.index;
    const vertices = [], seen = new Set(), faces = new Map(), edges = [];
    
    const vertex = (i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(part.matrixWorld);
    
    // 1. Собираем уникальные вершины
    for (let i = 0; i < positions.count; i++) {
        const p = vertex(i), key = p.toArray().map((v) => Math.round(v * 10000)).join(',');
        if (!seen.has(key)) { seen.add(key); vertices.push(p); }
    }
    
    // 2. Собираем ребра из контуров
    const outline = part.children.find((child) => child.isLineSegments);
    if (outline) {
        const attr = outline.geometry.attributes.position;
        for (let i = 0; i < attr.count; i += 2)
            edges.push([
                new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(part.matrixWorld),
                new THREE.Vector3().fromBufferAttribute(attr, i + 1).applyMatrix4(part.matrixWorld)
            ]);
    }
    
    // 3. Собираем плоские грани (для поиска их центров)
    const count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
        const triangle = new THREE.Triangle(
            vertex(index ? index.getX(i) : i),
            vertex(index ? index.getX(i + 1) : i + 1),
            vertex(index ? index.getX(i + 2) : i + 2)
        );
        const area = triangle.getArea();
        if (area < 1e-8) continue;
        
        const normal = triangle.getNormal(new THREE.Vector3()),
            plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, triangle.a);
        const key = normal.toArray().map((v) => Math.round(v * 10000)).concat(Math.round(plane.constant * 1000)).join(',');
        
        let face = faces.get(key);
        if (!face) {
            face = { plane, center: new THREE.Vector3(), area: 0, triangles: [] };
            faces.set(key, face);
        }
        face.center.addScaledVector(triangle.getMidpoint(new THREE.Vector3()), area);
        face.area += area;
        face.triangles.push(triangle);
    }
    for (const face of faces.values()) face.center.divideScalar(face.area); // Центр масс грани
    
    const result = { vertices, edges, faces: [...faces.values()] };
    part.userData.snapFeatures = result;
    return result;
}

/**
 * Проверяет, лежит ли точка на конкретной грани.
 */
function onFace(point, face) {
    return (
        Math.abs(face.plane.distanceToPoint(point)) < 0.02 &&
        face.triangles.some((triangle) => triangle.containsPoint(point))
    );
}

/**
 * Ищет ближайшую "магнитную" точку под курсором мыши.
 * Возвращает точку с привязкой или просто точку на поверхности.
 */
function snapPoint(hit, event) {
    const rect = engine.renderer.domElement.getBoundingClientRect(),
        projected = new THREE.Vector3();
    const features = snapFeatures(hit.object);
    
    // Вычисляем размер одного пикселя в мировых координатах (для радиуса привязки)
    const pixelSize = engine.camera.isOrthographicCamera
        ? (engine.camera.top - engine.camera.bottom) / engine.camera.zoom / rect.height
        : (2 * hit.point.distanceTo(engine.camera.position) * Math.tan((engine.camera.fov * Math.PI) / 360)) / rect.height;
    const candidates = [];
    
    // Функция для добавления кандидата (если он близко к курсору)
    function offer(point, type, priority, radius = 14) {
        if (!sectionTools.isVisible(point)) return; // Не привязываемся к отрезанным частям
        if (point.distanceTo(hit.point) > pixelSize * 22) return;
        projected.copy(point).project(engine.camera);
        if (projected.z < -1 || projected.z > 1) return;
        
        const distance = Math.hypot(
            ((projected.x + 1) * rect.width) / 2 + rect.left - event.clientX,
            ((1 - projected.y) * rect.height) / 2 + rect.top - event.clientY
        );
        if (distance <= radius) candidates.push({ point: point.clone(), type, priority, distance, snapped: true });
    }
    
    // Проверяем вершины (наивысший приоритет), середины ребер, центры граней
    if (heldSnap && heldSnap.part === hit.object) offer(heldSnap.point, heldSnap.type, -1, 22);
    for (const vertex of features.vertices) offer(vertex, 'vertex', 0);
    for (const edge of features.edges) offer(edge[0].clone().add(edge[1]).multiplyScalar(0.5), 'midpoint', 1);
    
    // Проверяем центры плоскостей и перпендикуляры
    for (const face of features.faces) {
        if (Math.abs(face.plane.distanceToPoint(hit.point)) > 0.03) continue;
        if (onFace(face.center, face)) offer(face.center, 'center', 2);
        if (pendingPoint) {
            const projection = face.plane.projectPoint(pendingPoint.point, new THREE.Vector3());
            if (projection.distanceTo(pendingPoint.point) > 0.01 && onFace(projection, face))
                offer(projection, 'plane', 3, 22);
        }
    }
    
    // Проверяем ребра (ближайшая точка на отрезке)
    {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1
        ), engine.camera);
        for (const edge of features.edges) {
            const point = new THREE.Vector3();
            ray.ray.distanceSqToSegment(edge[0], edge[1], new THREE.Vector3(), point);
            offer(point, 'edge', 4, 10);
        }
    }
    
    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);

    // Проверяем, не перекрыта ли привязка другой панелью
    for (const candidate of candidates) {
        const direction = candidate.point.clone().sub(engine.camera.position);
        let distance = direction.length();
        const ray = new THREE.Raycaster(engine.camera.position.clone(), direction.normalize(), 0, distance + 0.02);
        
        if (engine.camera.isOrthographicCamera) { /* ... */ }
        
        const occluder = ray.intersectObjects(model ? model.panels.filter((panel) => panel.visible) : [hit.object])
            .find((hit) => sectionTools.isVisible(hit.point));
        if (!occluder || occluder.distance >= distance - 0.03) return candidate;
    }
    
    // Если ничего не нашли — возвращаем точку на поверхности
    return { point: hit.point.clone(), snapped: false, type: 'surface' };
}

// ==========================================
// 11. ИЗМЕРЕНИЯ (ЛИНЕЙКА)
// ==========================================

function clearHover() {
    disposeObject(hoverGraphic);
    hoverGraphic = null;
    heldSnap = null;
    $('snap-label').hidden = true;
    $('snap-cursor').hidden = true;
    $('canvas').classList.remove('snap-magnet');
}

/**
 * Показывает визуальную подсветку (маркер) для точки привязки.
 */
function showSnapPreview(result, event) {
    clearHover();
    hoverGraphic = measurementGraphic([result.point]);
    if (result.snapped) {
        const hit = pick(event);
        if (result.type !== 'edge' && hit)
            heldSnap = { point: result.point.clone(), type: result.type, part: hit.object };
        const point = result.point.clone().project(engine.camera),
            rect = engine.renderer.domElement.getBoundingClientRect();
        $('snap-cursor').style.left = rect.left + ((point.x + 1) * rect.width) / 2 + 'px';
        $('snap-cursor').style.top = rect.top + ((1 - point.y) * rect.height) / 2 + 'px';
        $('snap-cursor').hidden = false;
        $('canvas').classList.add('snap-magnet');
    }
    
    const color = result.snapped ? 0x3f7c28 : 0x277fb4;
    hoverGraphic.children[0].material.color.setHex(color);
    hoverGraphic.children[0].material.size = result.type === 'vertex' ? 12 : 9;
    
    const rect = $('canvas').getBoundingClientRect();
    $('snap-label').textContent = snapNames[result.type];
    $('snap-label').hidden = false;
    $('snap-label').style.left = Math.min(event.clientX - rect.left + 18, Math.max(0, rect.width - 190)) + 'px';
    $('snap-label').style.top = Math.max(0, Math.min(event.clientY - rect.top + 15, rect.height - 40)) + 'px';
    $('snap-status').textContent = snapNames[result.type] + (pendingPoint ? ' · ' + mm(pendingPoint.point.distanceTo(result.point)) + ' мм' : '');
    render();
}

/**
 * Вычисляет расстояние и проекции по осям между двумя точками.
 */
function measurementValues(a, b) {
    const delta = b.clone().sub(a);
    return { length: delta.length(), axes: [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)] };
}

/**
 * Создает визуальный объект для измерения (точки и линию между ними).
 */
function measurementGraphic(points) {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const dotMaterial = new THREE.PointsMaterial({ color: 0x547a32, size: 6, sizeAttenuation: false, depthTest: false });
    
    // Делаем точки круглыми (а не квадратными)
    dotMaterial.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;');
    };
    
    const dots = new THREE.Points(geometry, dotMaterial);
    dots.renderOrder = 10;
    group.add(dots);
    
    if (points.length > 1) {
        const line = new THREE.Line(geometry.clone(), new THREE.LineBasicMaterial({ color: 0x547a32, depthTest: false }));
        line.renderOrder = 9;
        group.add(line);
    }
    engine.scene.add(group);
    return group;
}

/**
 * Добавляет точку для измерения. При клике второй раз — создает размер.
 */
function addMeasurementPoint(result) {
    clearHover();
    if (!pendingPoint) {
        pendingPoint = result;
        pendingMarker = measurementGraphic([result.point]);
        $('snap-status').textContent = 'Первая точка: ' + (snapNames[result.type] || (result.snapped ? 'вершина' : 'поверхность')) + '. Выберите вторую точку. Esc - отмена.';
    } else {
        const values = measurementValues(pendingPoint.point, result.point);
        if (values.length < 0.01) {
            $('snap-status').textContent = 'Точки совпадают. Выберите другую точку.';
            return;
        }
        
        const a = pendingPoint.point, b = result.point;
        const graphic = measurementGraphic([a, b]), label = document.createElement('span');
        label.className = 'measurement-label';
        label.textContent = mm(values.length) + ' мм';
        $('labels').append(label);
        
        measurements.push({
            a, b, values, graphic, label,
            snapped: pendingPoint.snapped && result.snapped,
            types: [pendingPoint.type || 'vertex', result.type || 'vertex']
        });
        cancelPending();
        $('snap-status').textContent = 'Размер добавлен. Выберите две точки для следующего измерения.';
    }
    renderMeasurements();
    render();
}

// ==========================================
// 12. РАБОТА С МАТЕРИАЛАМИ И ЦВЕТОМ
// ==========================================

/**
 * Обновляет свечение (emissive) панели в зависимости от того, выделена ли она 
 * или является ли она LED-профилем.
 */
function updateMaterialGlow(panel) {
    const material = panel.material,
        map = panel.userData.glow ? material.map : null;
    if (material.emissiveMap !== map) {
        material.emissiveMap = map;
        material.needsUpdate = true;
    }

    // Проверяем, выбрана ли сама панель ИЛИ фурнитура, принадлежащая этой панели
    let isSelected = panel === highlighted || highlightedGroup?.parts.has(panel);
    
    if (!isSelected && panel.userData.isHardware && panel.userData.treeNodeId) {
        // Если выбрана одна панель
        if (highlighted && highlighted.userData.treeNodeId === panel.userData.treeNodeId) {
            isSelected = true;
        } 
        // Если выбрана группа панелей (через Shift или дерево)
        else if (highlightedGroup) {
            isSelected = [...highlightedGroup.parts].some(p => p.userData.treeNodeId === panel.userData.treeNodeId);
        }
    }

    if (panel.userData.glow) {
        // Если это LED, красим в цвет света
        material.emissive.set((panel.userData.light || defaultLight).color).convertSRGBToLinear();
    } else {
        // Подсвечиваем зеленым, если это выбранная панель или её фурнитура
        material.emissive.setHex(isSelected ? 0x263e0a : 0);
    }
    
    material.emissiveIntensity = panel.userData.glow ? (panel.userData.light || defaultLight).power : 1;
    
    // Передаем направление света в шейдер (если выбрана конкретная грань)
    const shader = material.userData.ledShader,
        face = panel.userData.light?.face;
    if (shader) {
        shader.uniforms.ledDirectional.value = Array.isArray(face) ? 1 : 0;
        if (face) {
            shader.uniforms.ledFace.value.fromArray(face);
            if (panel.userData.localMatrix)
                shader.uniforms.ledFace.value.transformDirection(panel.userData.localMatrix);
        }
    }
}

/**
 * Запускает пересчет света от LED-профилей (вызывает "запекатель").
 */
function updateLEDLights() {
    if (!window.LEDLighting) return;
    if (!ledBaker)
        ledBaker = new LEDLighting.Baker(render, (text) => {
            $('light-status').textContent = text;
        });
        
    // Создаем "подпись" текущего состояния (какие панели видны и какие светятся),
    // чтобы не пересчитывать свет, если ничего не изменилось.
    const signature = model
        ? model.panels.map((panel) => (panel.visible ? '1' : '0')).join('') + '|' + model.panels
              .filter((panel) => panel.userData.glow)
              .map((panel) => panel.uuid + ':' + JSON.stringify(panel.userData.light || defaultLight))
              .join('|')
        : '';
    ledBaker.update(model, signature);
}

/**
 * Возвращает массив панелей, к которым нужно применить цвет.
 * (Все, выбранную или все с таким же материалом).
 */
function colorTargets() {
    if (!model) return [];
    const scope = $('color-scope').value;
    if (scope === 'all') return model.panels;
    if (!highlighted) return [];
    if (scope === 'material' && highlighted.userData.materialName)
        return model.panels.filter((panel) => panel.userData.materialName === highlighted.userData.materialName);
    return [highlighted];
}

/**
 * Возвращает массив панелей, которые могут светиться (только выбранная).
 */
function lightTargets() {
    return model && highlighted && model.panels.includes(highlighted) ? [highlighted] : [];
}

/**
 * Конвертирует цвет Three.js обратно в HEX-строку для отображения в UI.
 */
function displayColor(panel) {
    return '#' + panel.material.color.clone().convertLinearToSRGB().getHexString().toUpperCase();
}

/**
 * Синхронизирует панель "Материалы" (ползунки, цвета, кнопки) с текущим выделением.
 */
function updateColorControls() {
    const glowTargets = lightTargets();
    $('material-glow').disabled = !glowTargets.length;
    $('material-glow').checked = glowTargets.length > 0 && glowTargets.every((panel) => panel.userData.glow);
    $('material-glow').indeterminate = glowTargets.some((panel) => panel.userData.glow) && !$('material-glow').checked;
    $('choose-light-face').disabled = !glowTargets.length;
    $('choose-light-face').textContent = glowTargets[0]?.userData.light?.face ? 'Изменить светящуюся грань' : 'Выбрать светящуюся грань';
    
    const light = glowTargets[0]?.userData.light || defaultLight;
    for (const key of ['color', 'power', 'distance']) {
        $('light-' + key).value = light[key];
        $('light-' + key).disabled = !glowTargets.length;
    }
    $('light-power-value').textContent = mm(light.power);
    
    const targets = colorTargets(), enabled = targets.length > 0;
    for (const id of ['material-color', 'color-hex', 'reset-color']) $(id).disabled = !enabled;
    $('reset-all-colors').disabled = !model;
    for (const button of $('color-swatches').children) button.disabled = !enabled;
    
    if (!enabled) {
        $('color-target').textContent = 'Выберите деталь или материал';
        $('color-info').textContent = 'Выберите панель в 3D или материал в списке ниже.';
    } else {
        const color = displayColor(targets[0]);
        $('material-color').value = color;
        $('color-hex').value = color;
        const sameColor = targets.every((panel) => displayColor(panel) === color);
        
        $('color-target').textContent = $('color-scope').value === 'all' ? 'Вся модель' : 
            $('color-scope').value === 'material' && highlighted.userData.materialName ? highlighted.userData.materialName : highlighted.name;
            
        $('color-info').textContent = 'Деталей: ' + targets.length + (sameColor ? ' · ' + color : ' · Сейчас заданы разные цвета') + 
            (!highlighted?.userData.materialName && $('color-scope').value === 'material' ? '. Материал не указан - изменится только выбранная деталь.' : '');
    }
    syncTextureControls();
    renderMaterialList();
}

/**
 * Синхронизирует настройки текстуры в UI.
 */
function syncTextureControls() {
    const targets = colorTargets(),
        texture = targets.length ? targets[0].userData.texture : null;
    $('load-texture').disabled = !targets.length;
    for (const id of ['texture-scale', 'texture-rotation', 'texture-orientation', 'texture-mirror', 'remove-texture'])
        $(id).disabled = !targets.some((panel) => panel.userData.texture);
        
    const asset = texture ? textureAssets.get(texture.asset) : null;
    $('texture-preview-wrap').hidden = !asset;
    $('texture-placeholder').hidden = Boolean(asset);
    
    if (asset) {
        $('texture-preview').src = asset.url;
        $('texture-name').textContent = asset.name;
    } else {
        $('texture-preview').removeAttribute('src');
        $('texture-name').textContent = '';
    }
    
    if (texture) {
        $('texture-scale').value = texture.scale;
        $('texture-rotation').value = texture.rotation;
        $('texture-orientation').value = texture.orientation || 'auto';
        $('texture-mirror').checked = texture.mirror === true;
    }
    setMaterialEditor(materialEditor === 'light' ? 'light' : texture ? 'texture' : 'color');
}

/**
 * Переключает вкладки в редакторе материалов (Цвет, Текстура, Свет).
 */
function setMaterialEditor(mode) {
    if (mode === 'light') {
        if (materialEditor !== 'light') savedColorScope = $('color-scope').value;
        $('color-scope').value = 'part';
        $('color-scope').disabled = true;
        $('color-target').textContent = highlighted ? highlighted.name : 'Выберите деталь';
    } else {
        $('color-scope').disabled = false;
        if (materialEditor === 'light' && savedColorScope) {
            $('color-scope').value = savedColorScope;
            savedColorScope = null;
        }
    }
    if (mode !== 'light') {
        choosingLightFace = false;
        $('canvas').classList.remove('choosing-light-face');
    }
    materialEditor = mode;
    $('material-light-editor').hidden = mode !== 'light';
    $('mode-light').setAttribute('aria-pressed', String(mode === 'light'));
    $('material-color-editor').hidden = mode !== 'color';
    $('material-texture-editor').hidden = mode !== 'texture';
    $('mode-color').setAttribute('aria-pressed', String(mode === 'color'));
    $('mode-texture').setAttribute('aria-pressed', String(mode === 'texture'));
}

/**
 * Асинхронно загружает картинку текстуры, вычисляет её хеш и кэширует.
 */
async function loadTextureAsset(blob, name) {
    const token = request;
    if (blob.size > 8388608) throw new Error('Изображение должно быть не больше 8 МБ.');
    const hash = await TextureUtils.hash(await blob.arrayBuffer());
    if (textureAssets.has(hash)) return hash; // Если уже загружена — берем из кэша
    
    const url = URL.createObjectURL(blob), image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Не удалось прочитать изображение. Используйте JPG, PNG или WebP.'));
            image.src = url;
        });
        if (token !== request) throw new Error('Модель была изменена');
        if (image.width > 8192 || image.height > 8192 || image.width * image.height > 40000000)
            throw new Error('Изображение слишком большое: максимум 8192 px и 40 мегапикселей.');
        textureAssets.set(hash, { blob, url, image, name });
        return hash;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

/**
 * Пересчитывает UV-координаты для боковых стенок панели (чтобы текстура ложилась ровно).
 */
function updateTextureUV(panel, angle = 0) {
    const uv = panel.geometry.attributes.uv, base = panel.userData.baseUV;
    if (!uv || !base) return;
    uv.array.set(base); // Сбрасываем к базовым значениям

    const edgeAngle = angle + Math.PI / 2;
    const c = Math.cos(edgeAngle), s = Math.sin(edgeAngle);
    for (const range of panel.userData.sideUVRanges || [])
        for (let i = range.start; i < range.start + range.count; i++) {
            const u = base[i * 2], v = base[i * 2 + 1];
            uv.setXY(i, c * u - s * v, s * u + c * v);
        }
    uv.needsUpdate = true;
}

/**
 * Применяет текстуру к панели (создает THREE.Texture и настраивает повторение).
 */
function assignTexture(panel, specification) {
    const asset = specification ? textureAssets.get(specification.asset) : null;
    if (specification && !asset) throw new Error('Изображение текстуры не загружено');
    
    if (panel.material.map) panel.material.map.dispose(); // Очищаем старую текстуру
    panel.material.map = null;
    
    if (!specification) {
        // Снятие текстуры
        updateTextureUV(panel);
        delete panel.userData.texture;
        if (panel.userData.textureColor) {
            panel.material.color.copy(panel.userData.textureColor);
            delete panel.userData.textureColor;
        }
    } else {
        // Назначение новой текстуры
        if (!panel.userData.textureColor) panel.userData.textureColor = panel.material.color.clone();
        panel.material.color.setHex(0xffffff); // Белый цвет, чтобы текстура не затемнялась
        
        const map = new THREE.Texture(asset.image);
        map.encoding = THREE.sRGBEncoding;
        map.wrapS = map.wrapT = specification.mirror === true ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        map.repeat.set(1 / specification.scale, asset.image.width / asset.image.height / specification.scale);
        
        const direction = specification.orientation || 'auto';
        const baseAngle = direction === 'x' ? Math.PI / 2 : direction === 'y' ? 0 : panel.userData.textureAngle || 0;

        map.matrixAutoUpdate = false;
        const angle = baseAngle + (specification.rotation * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
        map.matrix.set(c * map.repeat.x, s * map.repeat.x, 0, -s * map.repeat.y, c * map.repeat.y, 0, 0, 0, 1);
        updateTextureUV(panel, angle);
        map.rotation = angle;
        map.anisotropy = engine.renderer.capabilities.getMaxAnisotropy ? Math.min(4, engine.renderer.capabilities.getMaxAnisotropy()) : 1;
        map.needsUpdate = true;
        panel.material.map = map;
        panel.userData.texture = { ...specification };
    }
    panel.material.needsUpdate = true;
}

/**
 * Обрабатывает выбор файла текстуры (из проводника или из галереи).
 */
async function chooseTexture(file) {
    if (!file) return;
    const token = request, operation = ++textureOperation, targets = colorTargets().slice();
    if (!targets.length) return;
    $('texture-status').textContent = 'Чтение текстуры…';
    try {
        pruneTextureAssets();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && !(file.type === '' && /\.(jpe?g|png|webp)$/i.test(file.name)))
            throw new Error('Поддерживаются JPG, PNG и WebP.');
            
        const asset = await loadTextureAsset(file, file.name);
        if (token !== request || operation !== textureOperation) return;
        
        const assigned = new Set(model.panels.filter((panel) => !targets.includes(panel) && panel.userData.texture).map((panel) => panel.userData.texture.asset));
        assigned.add(asset);
        if (assigned.size > 16) throw new Error('Максимум 16 разных текстур в проекте.');
        
        for (const panel of targets)
            assignTexture(panel, { asset, scale: 500, rotation: 0, orientation: 'auto', mirror: true });
            
        pruneTextureAssets();
        syncTextureControls();
        render();
        $('texture-status').textContent = 'Текстура назначена с направлением из B3D для каждой детали. Обновите проект для сохранения.';
    } catch (error) {
        if (token === request) $('texture-status').textContent = error.message;
    }
}

/**
 * Удаляет из памяти текстуры, которые больше не используются.
 */
function pruneTextureAssets() {
    const used = new Set(model ? model.panels.filter((panel) => panel.userData.texture).map((panel) => panel.userData.texture.asset) : []);
    for (const [hash, asset] of textureAssets)
        if (!used.has(hash)) {
            URL.revokeObjectURL(asset.url);
            textureAssets.delete(hash);
        }
}

/**
 * Применяет изменения масштаба или поворота текстуры.
 */
function changeTextureTransform() {
    const scale = Number($('texture-scale').value), rotation = Number($('texture-rotation').value);
    if (!Number.isFinite(scale) || scale < 10 || scale > 10000) {
        $('texture-status').textContent = 'Размер рисунка: от 10 до 10000 мм.';
        return;
    }
    for (const panel of colorTargets())
        if (panel.userData.texture)
            assignTexture(panel, {
                ...panel.userData.texture, scale, rotation,
                mirror: $('texture-mirror').checked,
                orientation: $('texture-orientation').value
            });
    syncTextureControls();
    render();
}

/**
 * Отрисовывает список материалов (сгруппированных по названию) в UI.
 */
function renderMaterialList() {
    $('material-list').replaceChildren();
    if (!model) return;
    const groups = new Map();
    for (const panel of model.panels) {
        const name = panel.userData.materialName || 'Без указанного материала';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(panel);
    }
    for (const [name, panels] of groups) {
        const button = document.createElement('button');
        button.className = 'material-item' + (highlighted && panels.includes(highlighted) ? ' active' : '');
        const chip = document.createElement('span');
        chip.className = 'material-chip';
        chip.style.background = displayColor(panels[0]);
        const text = document.createElement('span');
        text.className = 'material-text';
        text.textContent = name;
        const count = document.createElement('small');
        count.textContent = panels.length + ' деталей';
        text.append(count);
        button.append(chip, text);
        button.onclick = () => {
            if (isolated) showAll();
            $('color-scope').value = 'material';
            selectPart(panels[0]);
        };
        $('material-list').append(button);
    }
}

/**
 * Применяет выбранный цвет к панелям.
 */
function applyColor(value) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
        $('color-info').textContent = 'Введите HEX-цвет в формате #AABBCC.';
        return;
    }
    const targets = colorTargets();
    for (const panel of targets) {
        if (panel.userData.texture) assignTexture(panel, null); // Сбрасываем текстуру, если меняем цвет
        if (!panel.userData.originalColor) panel.userData.originalColor = panel.material.color.clone();
        panel.material.color.set(value).convertSRGBToLinear();
    }
    updateColorControls();
    render();
}

/**
 * Сбрасывает цвета на изначальные.
 */
function resetColors(all) {
    const targets = all && model ? model.panels : colorTargets();
    for (const panel of targets)
        if (panel.userData.originalColor) {
            if (panel.userData.textureColor) panel.userData.textureColor.copy(panel.userData.originalColor);
            else panel.material.color.copy(panel.userData.originalColor);
            delete panel.userData.originalColor;
        }
    updateColorControls();
    render();
}

/**
 * Показывает все панели (снимает режим изоляции).
 */
function showAll() {
    if (!model) return;
    model.panels.forEach((panel) => { panel.visible = true; });
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = true;
    renderPositionSearch();
    render();
}

/**
 * Создает/обновляет сетку на полу.
 */
function setGrid() {
    if (!model) return;
    disposeObject(engine.grid);
    const size = model.bounds.getSize(new THREE.Vector3()), center = model.bounds.getCenter(new THREE.Vector3()), extent = Math.max(...size.toArray());
    const grid = new THREE.Group(), span = Math.ceil((extent * 2) / 100) * 100;
    const helper = new THREE.GridHelper(span, 20, 0x53677d, 0x3a4c60);
    helper.position.set(center.x, model.bounds.min.y - 1, center.z);
    helper.material.transparent = true;
    helper.material.opacity = 0.4;
    const axes = new THREE.AxesHelper(extent * 0.22);
    axes.position.copy(model.bounds.min);
    grid.add(helper, axes);
    grid.visible = $('grid').checked;
    engine.grid = grid;
    engine.scene.add(grid);
}

/**
 * Полностью очищает сцену перед загрузкой новой модели.
 */
function clearModel() {
    sectionTools.reset();
    if (ledBaker) ledBaker.clear();
    choosingLightFace = false;
    $('canvas').classList.remove('choosing-light-face');
    closePartMenu();
    clearMeasurements();
    clearHover();
    if (engine) {
        selectPart(null);
        disposeObject(engine.grid);
        engine.grid = null;
        disposeObject(engine.shadowFloor);
        engine.shadowFloor = null;
    }
    isolated = false;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = true;
    if (!model || !engine) return;
    
    // Удаляем старую геометрию и материалы
    for (const group of [model.group, model.hardware]) {
        engine.scene.remove(group);
        group.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (object.material.map) object.material.map.dispose();
                object.material.dispose();
            }
        });
    }
    for (const asset of textureAssets.values()) URL.revokeObjectURL(asset.url);
    textureAssets.clear();
    textureOperation++;
    model = null;
    renderPositionSearch();
    updateColorControls();
    render();
}

// ==========================================
// 13. ЗАГРУЗКА И ПАРСИНГ ФАЙЛА B3D
// ==========================================

/**
 * Распаковывает zlib-поток из B3D файла и проверяет контрольную сумму (Adler-32).
 */
function inflateModel(bytes) {
    const raw = new pako.Inflate({ raw: true, chunkSize: 65536 }), chunks = [];
    let total = 0;
    raw.onData = (chunk) => {
        total += chunk.length;
        if (total > 256 * 1024 * 1024) throw new Error('Распакованный файл превышает 256 МБ');
        chunks.push(chunk.slice());
    };
    raw.push(bytes.subarray(2), true); // Пропускаем 2 байта заголовка zlib
    if (raw.err || !raw.ended) throw new Error('Не удалось распаковать геометрию B3D');
    
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }

    // Проверка контрольной суммы (Adler-32)
    const consumed = raw.strm.next_in, end = 2 + consumed;
    if (end + 4 > bytes.length) throw new Error('Оборванная контрольная сумма B3D');
    let a = 1, b = 0;
    for (let i = 0; i < output.length; i++) {
        a = (a + output[i]) % 65521;
        b = (b + a) % 65521;
    }
    const expected = new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0);
    if (((b << 16) | a) >>> 0 !== expected) throw new Error('Неверная контрольная сумма B3D');
    return output;
}

/**
 * Основная функция открытия файла B3D.
 * Читает файл, парсит геометрию, строит сцену и применяет настройки.
 */
async function openFile(file) {
    const token = ++request;
    selected = file;
    clearModel();
    
    // Обновляем UI
    $('title').textContent = $('detail-name').textContent = file.name;
    $('size').textContent = sizeLabel(file.size);
    $('modified').textContent = new Date(file.modified).toLocaleString('ru-RU');
    for (const id of ['format', 'dimensions', 'model-stats']) $(id).textContent = '-';
    $('selected-name').textContent = 'Не выбрана';
    $('selected-info').textContent = 'Нажмите на панель в модели';
    $('message').hidden = false;
    $('message').textContent = 'Чтение 3D-геометрии…';
    $('status').textContent = 'Загрузка…';

    try {
        initialize3D();
        if (file.size > 128 * 1024 * 1024) throw new Error('Файл превышает лимит просмотра 128 МБ.');
        
        const buffer = await file.local.arrayBuffer();
        if (token !== request) return;
        
        // Парсинг и сборка сцены
        const parsed = BazisB3D.parse(buffer, inflateModel), next = BazisScene.build(parsed, THREE);

        // АВТОПРИМЕНЕНИЕ ЦВЕТОВ МАТЕРИАЛОВ
        next.panels.forEach(panel => {
            const matName = (panel.userData.materialName || '').toLowerCase();
            for (const [key, props] of Object.entries(materialDatabase)) {
                if (matName.includes(key)) {
                    panel.material.color.set(props.color).convertSRGBToLinear();
                    if (props.roughness !== undefined) panel.material.roughness = props.roughness;
                    if (props.metalness !== undefined) panel.material.metalness = props.metalness;
                    panel.material.needsUpdate = true;
                    break;
                }
            }
        });

        if (!next.panels.length) {
            for (const g of [next.group, next.hardware])
                g.traverse((o) => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) o.material.dispose();
                });
            throw new Error('Поддерживаемая геометрия не найдена в модели.');
        }
        model = next;

        // СТИЛИ ДЛЯ ФУРНИТУРЫ (МЕТАЛЛ)
        if (model.hardware && model.hardware.children.length > 0) {
            const metalMaterial = new THREE.MeshStandardMaterial({
                color: 0xaaaaaa, metalness: 0.95, roughness: 0.15, envMapIntensity: 1.0
            });
            model.hardware.traverse((child) => {
                if (child.isMesh) {
                    child.material = metalMaterial;
                    child.castShadow = true;
                    child.receiveShadow = true;
                } else if (child.isLineSegments || child.isLine) {
                    if (child.material) child.material.color.setHex(0x555555);
                }
            });
        }

        // Финальная настройка сцены
        treeTools.setModel(model, file.name);
        engine.scene.add(model.group, model.hardware);
        model.hardware.visible = $('hardware').checked;
        $('position-search').value = '';
        setGrid();
        applyEdges();
        renderPositionSearch();
        updateColorControls();
        applyTransparency();
        applyRenderSettings();
        
        $('format').textContent = 'БАЗИС B3D · BZ85';
        const size = model.bounds.getSize(new THREE.Vector3());
        $('dimensions').textContent = dimensionText(size.toArray());
        $('model-stats').textContent = model.stats.panels + ' панелей · ' + model.stats.hardware + ' элементов фурнитуры' + (model.stats.layered ? ' · многослойных: ' + model.stats.layered : '');
        $('status').textContent = '3D-модель загружена' + (model.stats.unsupported ? ' · Не отображено объектов: ' + model.stats.unsupported : ' · Все панели прочитаны');
        
        if (model.warnings.length) console.warn('B3D:', model.warnings);
        $('message').hidden = true;
        fit(new THREE.Vector3(1, 0.65, 1.8).normalize()); // Приближаем камеру
    } catch (error) {
        if (token !== request) return;
        $('message').textContent = error.message;
        $('status').textContent = 'Ошибка открытия 3D-модели';
        console.error(error);
    }
}

/**
 * Включает/выключает прозрачность панелей (или делает их полупрозрачными при поиске).
 */
function applyTransparency() {
    if (!model) return;
    const searching = Boolean(($('position-search').value || '').trim()),
        matches = new Set(searching ? findPartsByPosition($('position-search').value) : []);
    for (const panel of model.panels) {
        const ghost = searching ? !matches.has(panel) : $('transparent').checked;
        panel.material.transparent = ghost;
        panel.material.opacity = ghost ? (searching ? 0.16 : 0.28) : 1;
        panel.material.depthWrite = !ghost;
        panel.material.needsUpdate = true;
        panel.castShadow = renderSettings.shadows && !ghost;
        panel.children.forEach((child) => {
            if (child.isLineSegments) child.material.opacity = ghost && searching ? 0.12 : 0.85;
        });
    }
    render();
}

/**
 * Включает/выключает отображение контуров (рёбер) панелей.
 */
function applyEdges() {
    if (!model) return;
    for (const panel of model.panels)
        panel.children.forEach((child) => {
            child.visible = $('edges').checked;
        });
    render();
}

/**
 * Отрисовывает список локально открытых файлов в панели.
 */
function renderLocalFiles() {
    const list = $('local-files');
    list.replaceChildren();
    if (!files.length) {
        const empty = document.createElement('p');
        empty.className = 'help';
        empty.textContent = 'Файлы ещё не открыты.';
        list.append(empty);
    }
    for (const file of files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wide';
        button.textContent = file.name + ' · ' + sizeLabel(file.size);
        button.onclick = () => openFile(file);
        list.append(button);
    }
}

/**
 * Добавляет выбранные пользователем файлы в список.
 */
function addFiles(items) {
    const accepted = [...items].filter((f) => /\.b3d$/i.test(f.name));
    if (!accepted.length) {
        $('status').textContent = 'Выберите файл .b3d';
        return;
    }
    for (const local of accepted)
        files.push({ name: local.name, size: local.size, modified: new Date(local.lastModified).toISOString(), local });
    renderLocalFiles();
    openFile(files[files.length - accepted.length]);
}
// ==========================================
// 14. ОБРАБОТЧИКИ СОБЫТИЙ ИНТЕРФЕЙСА
// ==========================================

$('open').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
};
$('welcome-open').onclick = () => $('file-input').click();

// Обработчики настроек рендера
for (const key of Object.keys(renderDefaults)) {
    const field = $('render-' + (key === 'shadowQuality' ? 'shadow-quality' : key));
    const update = () => {
        const value = typeof renderDefaults[key] === 'boolean' ? field.checked : typeof renderDefaults[key] === 'number' ? Number(field.value) : field.value;
        renderSettings = normalizeRenderSettings({ ...renderSettings, [key]: value });
        applyRenderSettings();
    };
    if (field.type === 'range' || field.type === 'color') field.oninput = update;
    else field.onchange = update;
}

for (const name of Object.keys(renderPresets))
    $('render-' + name).onclick = () => {
        renderSettings = { ...renderPresets[name] };
        applyRenderSettings();
    };

for (const [name, color] of Object.entries({ white: '#ffffff', gray: '#dfe5eb', dark: '#202b39' }))
    $('render-bg-' + name).onclick = () => {
        renderSettings.background = color;
        applyRenderSettings();
    };

$('render-reset').onclick = () => {
    renderSettings = { ...renderDefaults };
    applyRenderSettings();
};

// Зум
$('zoom-in').onclick = () => zoom(1.2);
$('zoom-out').onclick = () => zoom(1 / 1.2);

initializeViewCube();

// Переключатели
$('transparent').onchange = applyTransparency;
$('hardware').onchange = () => {
    if (model) {
        model.hardware.visible = $('hardware').checked && !isolated;
        render();
    }
};
$('selection-hardware').onchange = render;
$('perspective').onchange = () => setPerspective($('perspective').checked);
$('grid').onchange = () => {
    if (engine && engine.grid) {
        engine.grid.visible = $('grid').checked;
        render();
    }
};
$('edges').onchange = applyEdges;

// Полноэкранный режим
$('fullscreen').onclick = async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await $('app').requestFullscreen();
    } catch {
        $('status').textContent = 'Полный экран недоступен';
    }
};

// Кнопки работы с выделением
$('focus-part').onclick = () => highlighted && fit(null, new THREE.Box3().setFromObject(highlighted));
$('isolate-part').onclick = () => {
    if (!highlighted) return;
    if (isolated) showAll();
    else {
        model.panels.forEach((panel) => { panel.visible = panel === highlighted; });
        model.hardware.visible = false;
        isolated = true;
        $('isolate-part').setAttribute('aria-pressed', 'true');
        $('show-all').disabled = false;
        fit();
    }
};
$('show-all').onclick = showAll;
$('header-show-all').onclick = showAll;
$('header-focus').onclick = () => {
    if (!model) return;
    if (highlightedGroup) focusTreeParts(model.panels.flatMap((panel, index) => (highlightedGroup.parts.has(panel) ? [index] : [])));
    else if (highlighted) focusTreeParts([model.panels.indexOf(highlighted)]);
};

// Поиск по позициям
$('position-search').oninput = renderPositionSearch;
$('clear-position-search').onclick = () => {
    $('position-search').value = '';
    renderPositionSearch();
    $('position-search').focus();
};

// Контекстное меню (ПКМ)
$('hide-part').onclick = () => {
    if (highlightedGroup?.parts.size > 1) {
        const parts = selectedParts();
        closePartMenu();
        for (const part of parts) part.visible = false;
        treeVisibilityChanged();
    } else hidePart(contextPart);
};
$('context-drawing').onclick = () => {
    const part = contextPart, multiple = highlightedGroup?.parts.size > 1;
    closePartMenu();
    if (part && model && !multiple) window.PartDrawing.open(part, model);
};
$('context-focus').onclick = () => {
    const parts = selectedParts();
    closePartMenu();
    if (!parts.length) return;
    const bounds = new THREE.Box3();
    for (const part of parts) bounds.union(new THREE.Box3().setFromObject(part));
    fit(null, bounds);
};
$('context-isolate').onclick = () => {
    const part = contextPart;
    closePartMenu();
    if (!model || !part) return;
    const parts = new Set(selectedParts());
    model.panels.forEach((panel) => { panel.visible = parts.has(panel); });
    model.hardware.visible = false;
    isolated = true;
    $('isolate-part').setAttribute('aria-pressed', 'true');
    $('show-all').disabled = false;
    renderPositionSearch();
    fit();
};
$('context-show-all').onclick = () => { closePartMenu(); showAll(); };
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#part-menu')) closePartMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePartMenu(); });

// Вкладки
for (const [name] of Object.entries(tabNames)) {
    $('tab-' + name).onclick = () => {
        if (mobileLayout.matches && activeTab === name && !$('app').classList.contains('panel-closed')) $('toggle-panel').click();
        else openTab(name);
    };
    // Клавиатурная навигация по вкладкам
    $('tab-' + name).addEventListener('keydown', (event) => {
        const keys = Object.keys(tabNames).filter((key) => !$('tab-' + key).hidden && getComputedStyle($('tab-' + key)).display !== 'none'), index = keys.indexOf(name);
        let next = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = keys[(index + 1) % keys.length];
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = keys[(index + keys.length - 1) % keys.length];
        if (event.key === 'Home') next = keys[0];
        if (event.key === 'End') next = keys[keys.length - 1];
        if (next) { event.preventDefault(); openTab(next); $('tab-' + next).focus(); }
    });
}

// Палитра цветов
for (const color of swatches) {
    const button = document.createElement('button');
    button.style.setProperty('--swatch', color);
    button.title = color;
    button.setAttribute('aria-label', 'Цвет ' + color);
    button.disabled = true;
    button.onclick = () => applyColor(color);
    $('color-swatches').append(button);
}

$('material-color').oninput = (event) => applyColor(event.target.value);
$('material-glow').onchange = (event) => {
    for (const panel of lightTargets()) panel.userData.glow = event.target.checked;
    updateColorControls();
    render();
};
$('mode-light').onclick = () => setMaterialEditor('light');
$('choose-light-face').onclick = () => {
    choosingLightFace = !choosingLightFace;
    $('canvas').classList.toggle('choosing-light-face', choosingLightFace);
    $('light-status').textContent = choosingLightFace ? 'Нажмите на светящуюся грань профиля в модели. Esc - отмена.' : '';
};
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && choosingLightFace) {
        choosingLightFace = false;
        $('canvas').classList.remove('choosing-light-face');
        $('light-status').textContent = '';
    }
});

for (const key of ['color', 'power', 'distance'])
    $('light-' + key).oninput = () => {
        const settings = { color: $('light-color').value, power: Number($('light-power').value), distance: Number($('light-distance').value) };
        if (!Number.isFinite(settings.distance) || settings.distance < 50 || settings.distance > 10000) return;
        for (const panel of lightTargets()) panel.userData.light = { ...panel.userData.light, ...settings };
        $('light-power-value').textContent = mm(settings.power);
        render();
    };

$('color-hex').onchange = (event) => {
    let value = event.target.value.trim();
    if (!value.startsWith('#')) value = '#' + value;
    applyColor(value);
};
$('color-scope').onchange = updateColorControls;
$('reset-color').onclick = () => resetColors(false);
$('reset-all-colors').onclick = () => resetColors(true);
$('mode-color').onclick = () => { setMaterialEditor('color'); updateColorControls(); setMaterialEditor('color'); };
$('mode-texture').onclick = () => { setMaterialEditor('texture'); updateColorControls(); setMaterialEditor('texture'); };
$('load-texture').onclick = () => $('texture-input').click();
$('texture-input').onchange = (event) => { chooseTexture(event.target.files[0]); event.target.value = ''; };
$('texture-scale').onchange = changeTextureTransform;
$('texture-rotation').onchange = changeTextureTransform;
$('texture-mirror').onchange = changeTextureTransform;
$('texture-orientation').onchange = changeTextureTransform;
$('remove-texture').onclick = () => {
    textureOperation++;
    for (const panel of colorTargets()) assignTexture(panel, null);
    pruneTextureAssets();
    syncTextureControls();
    render();
    $('texture-status').textContent = 'Текстура снята. Для сохранения изменений обновите проект.';
};

$('undo-measure').onclick = () => {
    if (pendingPoint) {
        cancelPending();
        renderMeasurements();
        render();
        $('snap-status').textContent = 'Первая точка отменена. Выберите две точки.';
    } else removeMeasurement(measurements.length - 1);
};
$('clear-measures').onclick = () => { clearMeasurements(); $('snap-status').textContent = 'Измерения очищены.'; };

// Сворачивание панели
$('toggle-panel').onclick = () => {
    const closed = $('app').classList.toggle('panel-closed');
    $('toggle-panel').setAttribute('aria-expanded', String(!closed));
    $('toggle-panel').setAttribute('aria-label', closed ? 'Открыть панель инструментов' : 'Скрыть панель инструментов');
    $('toggle-panel').title = closed ? 'Открыть панель' : 'Скрыть панель';
};
$('resize-panel').onclick = () => {
    const expanded = $('app').classList.toggle('panel-expanded');
    $('resize-panel').setAttribute('aria-expanded', String(expanded));
    $('resize-panel').setAttribute('aria-label', expanded ? 'Уменьшить панель' : 'Развернуть панель');
    $('resize-panel').title = expanded ? 'Уменьшить панель' : 'Развернуть панель';
};

// Горячие клавиши
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingPoint) {
        cancelPending();
        renderMeasurements();
        render();
        $('snap-status').textContent = 'Первая точка отменена.';
    }
});
$('canvas').addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return;
    if (['+', '=', '-', '0'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '0') fit();
        else zoom(e.key === '-' ? 1 / 1.2 : 1.2);
    }
});

// Drag and Drop файлов
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('canvas').classList.add('drop-target');
});
document.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('canvas').classList.remove('drop-target'); } });
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('canvas').classList.remove('drop-target');
    addFiles(e.dataTransfer.files);
});

// Мобильная адаптация
const mobileLayout = window.matchMedia('(max-width:700px), (max-width:1000px) and (pointer:coarse)');
function syncMobileViewport() {
    if (!mobileLayout.matches) return;
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (height) $('app').style.setProperty('--app-height', Math.round(height) + 'px');
    const keyboard = window.visualViewport && window.innerHeight - height > 120;
    $('app').classList.toggle('keyboard-open', Boolean(keyboard));
}
if (mobileLayout.matches) { $('toggle-panel').click(); syncMobileViewport(); }
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncMobileViewport);
if (typeof window.addEventListener === 'function') window.addEventListener('resize', syncMobileViewport);
if (mobileLayout.addEventListener)
    mobileLayout.addEventListener('change', (event) => {
        if (event.matches) syncMobileViewport();
        else { $('app').style.removeProperty('--app-height'); $('app').classList.remove('keyboard-open', 'panel-expanded'); }
    });

syncRenderControls();

// ==========================================
// 15. ГАЛЕРЕЯ ТЕКСТУР (МОДАЛЬНОЕ ОКНО)
// ==========================================

function renderTextureGallery() {
    const grid = $('texture-modal-grid');
    if (!grid) return;
    grid.replaceChildren();
    
    const query = ($('texture-search')?.value || '').toLowerCase();
    const filtered = textureLibrary.filter(tex => tex.name.toLowerCase().includes(query));

    if (filtered.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #777; padding: 20px; font-size: 16px;">Ничего не найдено</div>';
        return;
    }

    // Ленивая загрузка картинок (Intersection Observer)
    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                if (img.dataset.src) {
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                }
                obs.unobserve(img);
            }
        });
    }, { root: grid, rootMargin: '200px' });

    filtered.forEach(tex => {
        const card = document.createElement('div');
        card.style.cssText = 'display: flex; flex-direction: column; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.05); cursor: pointer; transition: transform 0.1s;';
        
        const img = document.createElement('img');
        img.dataset.src = tex.path;
        img.style.cssText = 'width: 100%; aspect-ratio: 1 / 1; object-fit: cover; background: #e0e0e0; opacity: 0; transition: opacity 0.3s; display: block;';
        img.onload = () => { img.style.opacity = '1'; };

        const label = document.createElement('div');
        label.style.cssText = 'padding: 8px; font-size: 11px; color: #333; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        label.textContent = tex.name;

        card.appendChild(img);
        card.appendChild(label);

        card.onmouseenter = () => card.style.transform = 'scale(1.03)';
        card.onmouseleave = () => card.style.transform = 'scale(1)';

        card.onclick = async () => {
            if (!colorTargets().length) {
                alert('Сначала выберите деталь или материал в 3D-окне!');
                return;
            }
            
            try {
                label.textContent = 'Загрузка...';
                await new Promise((resolve, reject) => {
                    const fullImg = new Image();
                    fullImg.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = fullImg.width;
                        canvas.height = fullImg.height;
                        canvas.getContext('2d').drawImage(fullImg, 0, 0);
                        canvas.toBlob(async (blob) => {
                            const file = new File([blob], tex.name + '.jpg', { type: 'image/jpeg' });
                            await chooseTexture(file);
                            $('texture-status').textContent = 'Применено: ' + tex.name;
                            $('texture-modal').style.display = 'none';
                            resolve();
                        }, 'image/jpeg', 0.95);
                    };
                    fullImg.onerror = () => reject(new Error('Файл не найден'));
                    fullImg.src = tex.path;
                });
            } catch (err) {
                console.error(err);
                alert('Ошибка загрузки файла: ' + tex.path);
                label.textContent = tex.name;
            }
        };

        grid.appendChild(card);
        observer.observe(img);
    });
}

// Обработчики для модального окна галереи
if ($('open-texture-modal')) {
    $('open-texture-modal').onclick = () => {
        $('texture-modal').style.display = 'flex';
        $('texture-search').value = '';
        renderTextureGallery();
    };
}
if ($('close-texture-modal')) {
    $('close-texture-modal').onclick = () => { $('texture-modal').style.display = 'none'; };
}
if ($('texture-modal')) {
    $('texture-modal').addEventListener('click', (e) => {
        if (e.target.id === 'texture-modal') $('texture-modal').style.display = 'none';
    });
}
if ($('texture-search')) {
    $('texture-search').addEventListener('input', renderTextureGallery);
}

renderTextureGallery();
renderLocalFiles();
