'use strict';

console.log('dev-lambda');

var _ = require('lodash');
var app = require('express')();
var bodyParser = require('body-parser');
var childProcess = require('child_process');
var fs = require('fs');
var nodefn = require('when/node');
var path = require('path');
var when = require('when');

var lambdaBaseDir = process.argv[2] || process.env.LAMBDADEV_BASE_DIR || path.resolve(__dirname, '..', 'lambdas');
var defaultHandler = process.env.LAMBDADEV_DEFAULT_HANDLER || 'index.handler';
var defaultMaxMemory = parseInt(process.env.LAMBDADEV_DEFAULT_MAX_MEMORY) || 128;
var defaultTimeout = parseInt(process.env.LAMBDADEV_DEFAULT_TIMEOUT) || 3;
var maxConcurrency = parseInt(process.env.LAMBDADEV_MAX_CONCURRENCY) || 1;
var maxHistorySize = parseInt(process.env.LAMBDADEV_MAX_HISTORY) || 10;
var listenPort = parseInt(process.env.LAMBDADEV_PORT) || 8080;

app.use(bodyParser.json());
app.set('json spaces', '\t');

var lambdaConfigMap = {};
var historyMap = {};
var metricsMap = {};
var aggrega = {counts: {total: 0}};
var queue = [];

function loadLambdaBaseDir(baseDirPath) {
	return when()
		.then(function () {
			// remove lambdas that don't exist anymore
			var removeKeys = [];
			var lNameList = _.keys(lambdaConfigMap);
			
			return when.filter(lNameList, function (lName) {
				var dirPath = lambdaConfigMap[lName].dirPath;
				
				return nodefn.lift(fs.stat).bind(fs)(dirPath).then(function (stat) {
					// path doesn't exist or isn't a directory
					return !stat || !stat.isDirectory();
				});
			}).then(function (lName) {
				// ok remove the dead lambda
				delete lambdaConfigMap[lName];
			});
		})
		.then(function () {
			// get a list of the contents of lambdas base dir
			return nodefn.lift(fs.readdir).bind(fs)(baseDirPath);
		})
		.then(function (baseDirEntryList) {
			// filter down to just directories
			return when.filter(baseDirEntryList, function (baseDirEntry) {
				var entryPath = path.resolve(lambdaBaseDir, baseDirEntry);
				
				return nodefn.lift(fs.stat).bind(fs)(entryPath).then(function (stat) {
					return stat && stat.isDirectory();
				});
			})
		})
		.then(function (lNameList) {
			return when.map(lNameList, function (lName) {
				// set the source directory
				var dirPath = path.resolve(lambdaBaseDir, lName);
				
				var configFilePath = path.resolve(dirPath, 'config.json');
				
				var config;
				return nodefn.lift(fs.readFile).bind(fs)(configFilePath, 'utf8')
					.then(function (configFileContent) {
						config = JSON.parse(configFileContent);
					})
					.catch(function () {})
					.then(function () {
						lambdaConfigMap[lName] = {
							name: lName,
							dirPath: dirPath,
							handler: config && config.handler || defaultHandler,
							maxMemory: config && config.maxMemory || defaultMaxMemory,
							timeout: config && config.timeout || defaultTimeout
						};
						historyMap[lName] = [];
						metricsMap[lName] = {counts: {total: 0}};
					})
				;
			});
		})
	;
}

function getFormatedDate(date) {
	return date.getUTCFullYear() + '-'
		+ ('0' + (date.getUTCMonth() + 1)).substr(-2) + '-'
		+ ('0' + date.getUTCDate()).substr(-2) + ' '
		+ ('0' + date.getUTCHours()).substr(-2) + ':'
		+ ('0' + date.getUTCMinutes()).substr(-2) + ':'
		+ ('0' + date.getUTCSeconds()).substr(-2) + '.'
		+ ('00' + date.getUTCMilliseconds()).substr(-3)
	;
}

function getProcessMemory(child) {
	return when.promise(function (resolve, reject) {
		var psChild = childProcess.spawn('ps', ['-p' + child.pid, '-o', 'vsize=']);
		
		var psOutput = new Buffer(0);
		psChild.stdout.on('data', function (data) {
			psOutput = Buffer.concat([psOutput, data]);
		});
		psChild.on('close', function () {
			resolve(parseInt(psOutput.toString(), 10) || null);
		});
	});
}

function spawnLambda(config, event) {
	return when.promise(function (resolve, reject) {
		var result, metrics, timeoutKill, memoryCheckInterval;
		
		var child = childProcess.spawn('node', [], {cwd: config.dirPath, stdio: [null, null, null, 'ipc']});
		
		child.stdout.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			result.visible.updated = formated;
			result.visible.output = result.visible.output || [];
			result.visible.output.push(formated + ': ' + data.toString());
		});
		child.stderr.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			result.visible.updated = formated;
			result.visible.error = result.visible.error || [];
			result.visible.error.push(formated + ': ' + data.toString());
			result.visible.duration = ms - result.internal.started;
		});
		child.on('error', function (error) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			metrics.counts.error = (metrics.counts.error || 0) + 1;
			aggrega.counts.error = (aggrega.counts.error || 0) + 1;
			result.visible.status = 'error';
			result.visible.updated = formated;
			result.visible.error = result.visible.error || [];
			result.visible.error.push(formated + ': ' + error.toString());
			result.visible.duration = ms - result.internal.started;
		});
		child.on('close', function (code) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			metrics.counts.started--;
			aggrega.counts.started--;
			if (result.visible.status === 'started') {
				metrics.counts.done = (metrics.counts.done || 0) + 1;
				aggrega.counts.done = (aggrega.counts.done || 0) + 1;
				result.visible.status = 'done';
			}
			result.visible.updated = formated;
			result.visible.completed = formated;
			result.visible.duration = ms - result.internal.started;
			
			metrics.averageDuration = (result.visible.duration + (metrics.averageDuration || 0) * (metrics.counts.total - 1)) / metrics.counts.total;
			aggrega.averageDuration = (result.visible.duration + (aggrega.averageDuration || 0) * (aggrega.counts.total - 1)) / aggrega.counts.total;
			
			clearTimeout(timeoutKill);
			clearInterval(memoryCheckInterval);
			resolve();
		});
		child.on('message', function (message) {
			console.log('message', message);
			
			getProcessMemory(child).then(function (mem) {
				result.internal.baseMemory = mem;
				_.set(result, 'visible.overhead.memory', Math.ceil(mem / 1000));
				
				child.send({
					name: config.name,
					filename: config.handler.split('.', 1)[0] + '.js',
					exportHandler: config.handler.split('.', 2)[1],
					event: event
				});
			});
			
			timeoutKill = setTimeout(function () {
				_.set(metrics, 'counts.killed.timeout', _.get(metrics, 'counts.killed.timeout', 0) + 1);
				_.set(aggrega, 'counts.killed.timeout', _.get(aggrega, 'counts.killed.timeout', 0) + 1);
				result.visible.status = 'killed - timeout';
				child.kill();
			}, config.timeout * 1000);
			
			memoryCheckInterval = setInterval(function () {
				getProcessMemory(child).then(function (mem) {
					if (mem === null || mem < (result.internal.maxMemory || 0)) {
						return;
					}
					result.internal.maxMemory = mem;
					
					result.visible.maxMemory = Math.ceil((result.internal.maxMemory - result.internal.baseMemory) / 1000);
					
					if (result.visible.maxMemory > config.maxMemory) {
						_.set(metrics, 'counts.killed.maxMemory', _.get(metrics, 'counts.killed.maxMemory', 0) + 1);
						_.set(aggrega, 'counts.killed.maxMemory', _.get(aggrega, 'counts.killed.maxMemory', 0) + 1);
						result.visible.status = 'killed - maxed memory';
						child.kill();
					}
				});
			}, 100);
		});
		
		var loaderInit = ""
			+ "'use strict';"
			+ "var context = {"
			+ "	succeed: function (data) {process.exit();},"
			+ "	fail: function (data) {process.exit(1);}"
			+ "};"
			+ "process.on('message', function (message) {"
			+ "	console.log('message', message);"
			+ "	var lambda;"
			+ "	try {"
			+ "		lambda = require('./' + message.filename);"
			+ "	} catch (error) {"
			+ "		if (error.code !== 'MODULE_NOT_FOUND') {"
			+ "			throw error;"
			+ "		}"
			+ "		console.error('a js file was not found that corresponds to the file component of the handler property in config.json: expected js file=' + message.filename + '; lambda=' + message.name);"
			+ "		process.exit(1);"
			+ "	}"
			+ "	if (typeof lambda[message.exportHandler] !== 'function') {"
			+ "		console.error('the exports property specified by the handler property in config.json was not found in the lambda js file: exports property expected=' + message.exportHandler + '; lambda js file=' + message.filename + '; lambda=' + message.name);"
			+ "		process.exit(1);"
			+ "	}"
			+ "	lambda[message.exportHandler](message.event, context);"
			+ "});"
			+ "process.send(process.pid + ' ready');"
		;
		child.stdin.setEncoding('utf-8');
		child.stdin.write(loaderInit);
		child.stdin.end();
		
		var now = new Date();
		result = {
			visible: {
				status: 'started',
				started: getFormatedDate(now)
			},
			internal: {
				started: now.getTime()
			}
		};
		
		var history = historyMap[config.name];
		history.unshift(result);
		if (history.length > maxHistorySize) {
			history.pop();
		}
		
		metrics = metricsMap[config.name];
		metrics.counts.total++;
		aggrega.counts.total++;
		metrics.counts.started = (metrics.counts.started || 0) + 1;
		aggrega.counts.started = (aggrega.counts.started || 0) + 1;
	});
}

function getLambdaResponse(name) {
	var output = {};
	if (metricsMap[name]) {
		output.metrics = metricsMap[name];
	}
	if (historyMap[name]) {
		output.history = _.map(historyMap[name], function (cache) {
			return cache.visible;
		});
	}
	output.config = lambdaConfigMap[name];
	return output;
}

function processUntilDone(config, event) {
	spawnLambda(config, event).then(function () {
		var next = queue.shift();
		if (next) {
			var metrics = metricsMap[next.config.name];
			metrics.counts.queued--;
			aggrega.counts.queued--;
			processUntilDone(next.config, next.event)
		}
	});
}

function queueLambda(config, event) {
	if ((aggrega.counts.started || 0) < maxConcurrency) {
		processUntilDone(config, event);
	} else {
		queue.push({config: config, event: event});
		
		var metrics = metricsMap[config.name];
		metrics.counts.queued = (metrics.counts.queued || 0) + 1;
		aggrega.counts.queued = (aggrega.counts.queued || 0) + 1;
	}
}

loadLambdaBaseDir(lambdaBaseDir).then(function () {
	console.log('serving lambdas');
	
	app.get('/', function(req, res) {
		console.log('GET /');
		var output = {};
		_.forOwn(lambdaConfigMap, function (config, name) {
			output[name] = getLambdaResponse(name);
		});
		output.metrics = aggrega;
		output.maxConcurrency = maxConcurrency;
		res.send(output);
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.get('/' + config.name, function (req, res) {
			console.log('GET /' + config.name);
			res.send(getLambdaResponse(name));
		});
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.post('/' + config.name, function (req, res) {
			console.log('POST /' + config.name);
			queueLambda(config, req.body);
			res.send(getLambdaResponse(name));
		});
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.post('/sync/' + config.name, function (req, res) {
			console.log('POST /sync/' + config.name);
			spawnLambda(config, req.body).then(function () {
				res.send(getLambdaResponse(name));
			});
		});
	});
	
	app.listen(listenPort);
});
