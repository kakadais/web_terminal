import { Mongo } from 'meteor/mongo';

export const Servers = new Mongo.Collection('servers');
export const ConnectionHistory = new Mongo.Collection('connection_history');
