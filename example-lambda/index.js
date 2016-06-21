'use strict';

exports.handler = function (event, context) {
	console.log('Hello World!');
	console.log('event', event);
	console.log('name', context.functionName);
	context.succeed();
};
