Module['arguments'] = Module['arguments'] || []
Module['arguments'].push(
	'-game', 'portal',
	'-noip',
	'-language', 'english',
	'-windowed',
	'+mat_hdr_level', '0',
	'+mat_colorcorrection', '1'
)

const ENV_IS_WORKER = typeof importScripts !== 'undefined'

if (ENV_IS_WORKER) {
	// ===================== WORKER (PTHREAD) =====================

	const FS_LOCK = new Int32Array(Module._FS_SAB_LOCK)
	const FS_META = new Int32Array(Module._FS_SAB_META)
	const FS_DATA = new Uint8Array(Module._FS_SAB_DATA)
	let _populating = false

	function syncReadFile(vfsPath) {
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		console.log('WORKER syncReadFile: path=' + vfsPath + ' pathLen=' + p.length)
		if (p.length > FS_DATA.length) return null
		FS_DATA.set(p, 0)
		FS_META[0] = 0
		FS_META[1] = p.length
		FS_META[2] = 0
		FS_META[3] = 0

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		const exists = FS_META[3] === 0
		const resultLen = FS_META[2]
		console.log('WORKER syncReadFile: exists=' + exists + ' dataLen=' + resultLen)
		if (FS_META[3] !== 0) return null
		return FS_DATA.slice(0, FS_META[2])
	}

	function syncWriteFile(vfsPath, data) {
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		if (8 + p.length + data.length > FS_DATA.length) return false

		FS_DATA.set(p, 0)
		FS_DATA.set(data, 8 + p.length)
		FS_META[0] = 1
		FS_META[1] = p.length
		FS_META[2] = data.length
		FS_META[3] = 0

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		return FS_META[3] === 0
	}

	function lazyLoadFile(vfsPath) {
		const data = syncReadFile(vfsPath)
		if (!data) return false
		_populating = true
		try {
			const parts = vfsPath.split('/')
			parts.pop()
			const dirPath = parts.join('/')
			if (dirPath) FS.mkdirTree(dirPath)
			FS.writeFile(vfsPath, new Uint8Array(data))
			return true
		} finally {
			_populating = false
		}
	}

	function isENOENT(e) {
		return Math.abs(e.errno) === 2 || Math.abs(e.errno) === 44
	}

	Module.preRun = Module.preRun || []
	Module.preRun.push(function () {
		console.log('WORKER prerun: waiting for dir index...')
		while (Atomics.load(FS_META, 4) === 0) {
			Atomics.wait(FS_META, 4, 0, 100)
		}
		const dirDataLen = FS_META[5]
		const dirStr = new TextDecoder().decode(FS_DATA.slice(0, dirDataLen))
		console.log('WORKER prerun: got ' + dirDataLen + ' bytes of dirs, creating...')
		for (const dir of dirStr.split('\n')) {
			if (dir) try { FS.mkdirTree(dir) } catch (e) {}
		}
		console.log('WORKER prerun: dirs created, installing FS overrides')

		const _origOpen = FS.open
		FS.open = function (path, rawFlags) {
			if (_populating) return _origOpen(path, rawFlags)
			const flags = typeof rawFlags === 'string'
				? FS.modeStringToFlags(rawFlags)
				: rawFlags
			try {
				return _origOpen(path, flags)
			} catch (e) {
				if (!isENOENT(e)) throw e
				if (flags & 64) throw e

				const resolved = PATH.resolve(FS.cwd(), path)
				console.log('WORKER FS.open ENOENT: path=' + path + ' resolved=' + resolved)
				if (lazyLoadFile(resolved)) {
					console.log('WORKER FS.open: lazy-loaded ' + resolved)
					return _origOpen(path, flags)
				}
				console.log('WORKER FS.open: lazy-load FAILED for ' + resolved)
				throw e
			}
		}

		const _origStat = FS.stat
		FS.stat = function (path, dontFollow) {
			try {
				return _origStat(path, dontFollow)
			} catch (e) {
				if (!isENOENT(e)) throw e
				const resolved = PATH.resolve(FS.cwd(), path)
				console.log('WORKER FS.stat ENOENT: path=' + path + ' resolved=' + resolved)
				if (lazyLoadFile(resolved)) {
					console.log('WORKER FS.stat: lazy-loaded ' + resolved)
					return _origStat(path, dontFollow)
				}
				console.log('WORKER FS.stat: lazy-load FAILED for ' + resolved)
				throw e
			}
		}

		const _origLookupPath = FS.lookupPath
		FS.lookupPath = function (path, opts) {
			try {
				return _origLookupPath(path, opts)
			} catch (e) {
				if (!isENOENT(e)) throw e
				const resolved = PATH.resolve(FS.cwd(), path)
				console.log('WORKER FS.lookupPath ENOENT: path=' + path + ' resolved=' + resolved)
				if (lazyLoadFile(resolved)) {
					console.log('WORKER FS.lookupPath: lazy-loaded ' + resolved)
					return _origLookupPath(path, opts)
				}
				console.log('WORKER FS.lookupPath: lazy-load FAILED for ' + resolved)
				throw e
			}
		}

		const _origWrite = FS.write
		FS.write = function (stream, buffer, offset, length, position) {
			stream._dirty = true
			return _origWrite(stream, buffer, offset, length, position)
		}

		const _origClose = FS.close
		FS.close = function (stream) {
			if (stream._dirty && stream.node) {
				try {
					const data = FS.readFile(stream.node.path, { encoding: 'binary' })
					syncWriteFile(stream.node.path, new Uint8Array(data))
				} catch (e) {}
			}
			return _origClose(stream)
		}
	})

	Module.downloadMap = (lock, mapName) => {
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	}
} else {
	// ===================== MAIN THREAD =====================

	// Force array-buffer compilation (streaming can fail with COEP)
	delete WebAssembly.instantiateStreaming;

	console.log('MAIN: pre.js loaded');

	const _origAddDep = addRunDependency;
	const _origRemoveDep = removeRunDependency;
	addRunDependency = function(id) {
		console.log('MAIN addRunDependency:', id);
		_origAddDep(id);
	};
	removeRunDependency = function(id) {
		console.log('MAIN removeRunDependency:', id);
		_origRemoveDep(id);
	};

	let _lock = new Int32Array(Module._FS_SAB_LOCK)
	let _meta = new Int32Array(Module._FS_SAB_META)
	let _data = new Uint8Array(Module._FS_SAB_DATA)

	Module.fsRequest = async function () {
		if (!_lock || Atomics.load(_lock, 0) !== 1) return

		const type = _meta[0]
		const pathLen = _meta[1]
		const path = new TextDecoder().decode(new Uint8Array(_data.buffer, 0, pathLen))
		console.log('MAIN fsRequest: type=' + type + ' path=' + path + ' pathLen=' + pathLen)

		if (type === 0) {
			const data = await Module._readFileFromFolder(path)
			if (data) {
				console.log('MAIN fsRequest: readFile OK len=' + data.length)
				_data.set(data, 0)
				_meta[2] = data.length
				_meta[3] = 0
			} else {
				console.log('MAIN fsRequest: readFile NOT FOUND')
				_meta[2] = 0
				_meta[3] = 1
			}
		} else if (type === 1) {
			const dataLen = _meta[2]
			const fileData = new Uint8Array(_data.buffer, 8 + pathLen, dataLen)
			await Module._writeFileToFolder(path, new Uint8Array(fileData))
			_meta[2] = 0
			_meta[3] = 0
		} else if (type === 2) {
			const exists = Module._pathExistsInFolder(path)
			console.log('MAIN fsRequest: existsCheck path=' + path + ' result=' + exists)
			_meta[3] = exists ? 0 : 1
		}

		Atomics.store(_lock, 0, 0)
		Atomics.notify(_lock, 0)
	}

	Module._pathExistsInFolder = function (path) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		const exists = Module._dirIndex && Module._dirIndex.has(clean)
		console.log('MAIN _pathExistsInFolder: raw=' + path + ' clean=' + clean + ' exists=' + exists)
		return exists
	}

	Module._readFileFromFolder = async function (path) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		const handle = Module._dirIndex && Module._dirIndex.get(clean)
		if (!handle) {
			console.log('MAIN _readFileFromFolder: NOT FOUND clean=' + clean + ' dirIndex.size=' + (Module._dirIndex ? Module._dirIndex.size : 'null'))
			return null
		}
		console.log('MAIN _readFileFromFolder: FOUND clean=' + clean)
		const file = await handle.getFile()
		const data = new Uint8Array(await file.arrayBuffer())
		console.log('MAIN _readFileFromFolder: read ' + data.length + ' bytes')
		return data
	}

	Module._writeFileToFolder = async function (path, data) {
		if (!Module._rootHandle) return
		const clean = path.replace(/^\/+/, '')
		const parts = clean.split('/')
		const fileName = parts.pop()
		let cur = Module._rootHandle
		for (const part of parts) {
			if (!part) continue
			cur = await cur.getDirectoryHandle(part, { create: true })
		}
		const fh = await cur.getFileHandle(fileName, { create: true })
		const w = await fh.createWritable()
		await w.write(data)
		await w.close()
	}

	Module._sendFolderIndexToWorker = function () {
		if (!_meta || !_data) {
			console.log('MAIN _sendFolderIndexToWorker: retrying (meta/data not ready)')
			setTimeout(Module._sendFolderIndexToWorker, 50)
			return
		}
		const allPaths = Array.from(Module._dirIndex.keys()).sort()
		console.log('MAIN _sendFolderIndexToWorker: ' + allPaths.length + ' paths, first few: ' + allPaths.slice(0, 5).join(', '))
		const dirSet = new Set()
		for (const fp of allPaths) {
			const parts = fp.split('/')
			let path = ''
			for (let i = 0; i < parts.length - 1; i++) {
				path += '/' + parts[i]
				dirSet.add(path)
			}
		}
		const dirs = Array.from(dirSet).sort()
		const encoded = new TextEncoder().encode(dirs.join('\n'))

		if (encoded.length > _data.length) {
			console.error('Directory index too large for data buffer')
			return
		}

		_data.set(encoded, 0)
		_meta[4] = 1
		_meta[5] = encoded.length
		console.log('MAIN _sendFolderIndexToWorker: sent ' + dirs.length + ' dirs, ' + encoded.length + ' bytes')
		Atomics.notify(_meta, 4)
	}
}
