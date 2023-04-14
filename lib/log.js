const colors = require('colors');

class Log {
    constructor(subject) {
        this.subject = subject;
    }

    info() {
        arguments[0] = '[' + new Date().toISOString() + '] [' + this.subject + '] ' + arguments[0];
        console.log.apply(console, arguments);
    }

    error() {
        arguments[0] = '[' + new Date().toISOString() + '] [' + this.subject + '] ' + arguments[0];
        arguments[0] = colors.red(arguments[0]);

        for (let index = 0; index < arguments.length; index++) {
            if (arguments[index] instanceof Error) {
                console.log(arguments[index].stack);
            }
        }

        console.error.apply(console, arguments);
    }
}

module.exports = function(subject) {
    let logger = new Log(subject);
    let ret = logger.info.bind(logger);
    ret.error = logger.error.bind(logger);
    return ret;
};