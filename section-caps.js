(function (root) {
    'use strict';

    function geometry(source, plane, THREE) {
        const position = source.attributes.position,
            index = source.index;
        const normal = plane.normal,
            origin = normal.clone().multiplyScalar(-plane.constant);
        const u = new THREE.Vector3(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0)
            .cross(normal)
            .normalize();
        const v = normal.clone().cross(u),
            points = new Map(),
            edges = new Map();
        const epsilon = 1e-4;
        function key(p) {
            return Math.round(p.x / epsilon) + ':' + Math.round(p.y / epsilon);
        }
        const vertex = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
        for (let i = 0, count = index ? index.count : position.count; i < count; i += 3) {
            const triangle = [vertex(i), vertex(i + 1), vertex(i + 2)],
                hits = [];
            const distances = triangle.map((p) => plane.distanceToPoint(p));
            if (!distances.some((d) => d > epsilon) || !distances.some((d) => d < -epsilon)) continue;
            for (let j = 0; j < 3; j++) {
                const a = triangle[j],
                    b = triangle[(j + 1) % 3],
                    da = distances[j],
                    db = distances[(j + 1) % 3];
                if (Math.abs(da) <= epsilon) hits.push(a.clone());
                else if (da * db < 0) hits.push(a.clone().lerp(b, da / (da - db)));
            }
            const projected = new Map();
            for (const hit of hits) {
                const delta = hit.sub(origin),
                    p = new THREE.Vector2(delta.dot(u), delta.dot(v));
                projected.set(key(p), p);
            }
            if (projected.size !== 2) continue;
            const [a, b] = [...projected.keys()],
                edgeKey = [a, b].sort().join('|');
            if (edges.has(edgeKey)) continue;
            edges.set(edgeKey, [a, b]);
            for (const [id, p] of projected) if (!points.has(id)) points.set(id, { p, neighbors: [] });
            points.get(a).neighbors.push(b);
            points.get(b).neighbors.push(a);
        }
        const loops = [],
            used = new Set();
        for (const start of points.keys()) {
            if (used.has(start)) continue;
            const loop = [];
            let current = start,
                previous = null,
                closed = false;
            while (!used.has(current)) {
                const entry = points.get(current);
                used.add(current);
                loop.push(entry.p);
                if (entry.neighbors.length !== 2) break;
                const next = entry.neighbors.find((id) => id !== previous);
                if (next === start) {
                    closed = true;
                    break;
                }
                previous = current;
                current = next;
            }
            if (closed && loop.length >= 3) loops.push(loop);
        }
        const inside = (p, loop) => {
            let result = false;
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[i],
                    b = loop[j];
                if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result;
            }
            return result;
        };
        const depths = loops.map((loop, i) => loops.filter((other, j) => i !== j && inside(loop[0], other)).length);
        const positions = [],
            uv = [];
        loops.forEach((loop, i) => {
            if (depths[i] % 2) return;
            const holes = loops.filter((hole, j) => depths[j] === depths[i] + 1 && inside(hole[0], loop));
            const all = loop.concat(...holes);
            for (const face of THREE.ShapeUtils.triangulateShape(loop, holes))
                for (const id of face) {
                    const p = all[id],
                        world = origin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y);
                    positions.push(world.x, world.y, world.z);
                    uv.push(p.x / 12, p.y / 12);
                }
        });
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        result.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        result.computeVertexNormals();
        const outline = [];
        for (const loop of loops)
            for (let i = 0; i < loop.length; i++) {
                for (const p of [loop[i], loop[(i + 1) % loop.length]]) {
                    const world = origin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y);
                    world.addScaledVector(normal, -0.03);
                    outline.push(world.x, world.y, world.z);
                }
            }
        result.userData.sectionOutline = outline;
        return result;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { geometry };
    else root.SectionCaps = { geometry };
})(typeof globalThis !== 'undefined' ? globalThis : this);
