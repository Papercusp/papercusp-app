import * as importedGremlins from 'gremlins.js';

const gremlins = (importedGremlins as { default?: unknown }).default ?? importedGremlins;

export default gremlins;
