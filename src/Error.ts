export interface ErrorInfo{
	simpleMessage?: string;
	error?: any;
}

function parseErrorArg(arg?: any, defaultSimpleMessage?: string){
	if(typeof arg != 'object'){
		if(arg !== undefined)
			arg = arg.toString();
		return {
			message: arg,
			simpleMessage: defaultSimpleMessage
		};
	}

	if(arg instanceof Error){
		return {
			message: arg.message,
			simpleMessage: (arg as any).simpleMessage ?? defaultSimpleMessage
		}
	}

	let info = arg as ErrorInfo | undefined;
	let message, simpleMessage = info?.simpleMessage;

	if(info?.error instanceof Error){
		message = info.error.message;

		if(!simpleMessage)
			simpleMessage = (info.error as any).simpleMessage;
	}else{
		message = info?.error ?? simpleMessage;
	}

	if(!simpleMessage)
		simpleMessage = defaultSimpleMessage;
	return {
		message: message ?? simpleMessage,
		simpleMessage
	}
}

export class GenericError extends Error{
	simpleMessage?: string;

	constructor(arg?: any, defaultSimpleMessage?: string){
		let {message, simpleMessage} = parseErrorArg(arg, defaultSimpleMessage);

		super(message);
		this.name = this.constructor.name;
		this.simpleMessage = simpleMessage;
	}

	userFriendlyMessage(){
		return this.simpleMessage ?? 'Unknown error';
	}
}

export class ParseError extends GenericError{
	constructor(arg?: any){
		super(arg, 'Error processing input');
	}
}

export class InternalError extends GenericError{
	constructor(arg?: any){
		super(arg, 'Internal error');
	}
}

export class NotFoundError extends GenericError{
	constructor(arg?: any){
		super(arg, 'Entity not found');
	}
}

export class NetworkError extends GenericError{
    constructor(arg?: any){
        super(arg, 'Network error');
    }
}

export class UnsupportedError extends GenericError{
	constructor(arg?: any){
		super(arg, 'Function not supported');
	}
}

export class UnplayableError extends GenericError {
    constructor (arg: any) {
        super(arg, 'Track is unplayable')
    }
}

export class NotATrackError extends GenericError {
    constructor (arg: any) {
        super(arg, 'Link does not lead to a track')
    }
}
