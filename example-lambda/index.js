'use strict';

exports.handler = function (event, context) {
	console.log('Hello World!');
	console.log('event', event);
	context.succeed();
};
