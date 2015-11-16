var baseURL = getInformITBaseURL();

requirejs.config({
	baseUrl: baseURL + "js/"
});

require(["./manifest.js", "buildpage"], function (manifest, BuildPage) {
	BuildPage.build(manifest);

	require(["./search_index.js"], function (search_index) {
		BuildPage.setSearchIndex(search_index);
	}, function (err) {
		var failedId = err.requireModules && err.requireModules[0];
		if (failedId === "search_index.js") {
			console.log("No search index found. No problem.");

		}

		requirejs.undef(failedId);
	})
});