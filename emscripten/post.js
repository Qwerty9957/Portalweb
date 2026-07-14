

;(() => {
	if(typeof window === 'undefined') return;

	window.addEventListener('beforeunload', function (event) {
		event.preventDefault()
	})

	canvasElement.onkeypress = e => e.preventDefault()

	addRunDependency('load_game_data')
})();
