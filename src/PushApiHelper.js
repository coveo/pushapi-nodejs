/* eslint-disable no-console */
'use strict';

const request = require('request');

class PushApiHelper {

  constructor() {
    this._dir = process.cwd();
    try {
      this.config = require(`${this._dir}/.pushapi-config`);
    } catch (e) {
      PushApiHelper.throwError(`Couldn't load .pushapi-config.json file from ${this._dir}`);
    }

    this.validateConfig();
    this._debug('\nconfig = ', this.config);
  }

  _debug() {
    if (this.config.debug) {
      console.debug.apply(console, arguments);
    }
  }

  _log() {
    console.log.apply(console, arguments);
  }

  /**
   * Utility function to check if a key in a JSON object. The JSON payload for the Push Api is case-insensitive, so DocumentId is the same as documentid.
   * @param {string} key
   * @param {Object} obj
   */
  _isKeyMissingInObject(key, obj) {
    let keys = Object.keys(obj).map(k => k.toLowerCase());
    return !(keys.includes(key.toLowerCase()));
  }

  async _sendRequest(method, action) {
    let config = this.config,
      url = /^http/.test(action) ? action : `https://${config.platform}/v1/organizations/${config.org}/sources/${config.source}/${action}`;

    return new Promise((resolve, reject) => {
      request({
          method: method,
          url: url,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
        },
        (error, response, body) => {
          if (error) {
            console.log('ERROR: ', error, response.statusCode, url);
            console.log('ERROR-msg: ', body);
            reject(error);
          } else {
            console.log('\nREQUEST: ', method, url, response.statusCode, response.statusMessage);
            resolve(body);
          }
        })
    });
  }

  async changeStatus(state) {
    return this._sendRequest(`POST`, `status?statusType=${state}`);
  }

  async deleteOlderThan(orderingId) {
    if (orderingId < Date.now()) {
      return this._sendRequest(`DELETE`, `documents/olderthan?orderingId=${orderingId}`);
    }
  }

  async getLargeFileContainer() {
    let config = this.config;
    return this._sendRequest(`POST`, `https://${config.platform}/v1/organizations/${config.org}/files`).then(
      body => {
        console.log('getLargeFileContainer', typeof body);
        let resp = (typeof body === 'string') ? JSON.parse(body) : body;

        this.uploadUri = resp.uploadUri;
        this.fileId = resp.fileId;

        this._debug('uploadUri: ', resp.uploadUri);
        this._log('fileId: ', resp.fileId);

        return resp;
      }
    );
  }

  async pushFile(data) {
    // validate payload first
    if (!data) {
      console.warn('Invalid payload: not defined.');
    }
    if (data instanceof Array) {
      data = {
        AddOrUpdate: data
      }; // need to wrap arrays of documents into AddOrUpdate
    }

    if (this._isKeyMissingInObject('AddOrUpdate', data)) {
      // wrap payload into {"AddOrUpdate": [data]}
      data = {
        AddOrUpdate: [
          data
        ]
      };
    } else if (!data.AddOrUpdate) {
      // AddOrUpdate is present, but using a different case.

      // find the key using the different case
      let key = Object.keys(data).filter(k => k.match(/AddOrUpdate/i))[0];

      // replacing key by 'AddOrUpdate'
      data.AddOrUpdate = data[key];
      delete data[key];
    }

    let fileExtensionWarning = false;
    // validate each document has a DocumentId
    data.AddOrUpdate.forEach(d => {
      if (this._isKeyMissingInObject('DocumentId', d)) {
        console.warn(`Missing DocumentId in some documents in the payload. Stopping.`);
        throw new Error('No DocumentId.');
      }
      if (!fileExtensionWarning && this._isKeyMissingInObject('FileExtension', d)) {
        console.log(`Missing FileExtension in some documents. It's good practice to provide them.`);
        fileExtensionWarning = true;
      }
    });

    // push
    return await this.pushJsonPayload(data);
  }

  async pushJsonPayload(data) {
    // push
    await this.changeStatus('REBUILD');
    try {
      await this.getLargeFileContainer();
      await this.uploadJson(data);
      await this.sendBatchRequest();
    } catch (err) {
      console.log(err);
    }

    await this.changeStatus('IDLE');
  }

  async sendBatchRequest(fileId) {
    return this._sendRequest(`PUT`, `documents/batch?fileId=${fileId || this.fileId}`);
  }

  static throwError(msg, code) {
    console.warn(`\n\t${msg}`);
    process.exit(code || 1);
  }

  async uploadJson(body) {
    return new Promise((resolve, reject) => {
      request({
        method: 'PUT',
        url: this.uploadUri,
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-amz-server-side-encryption': 'AES256'
        },
        maxContentLength: 256000000, // 256 MB
        maxBodyLength: 256000000,
        body,
        json: true,
      }, (error, response) => {
        if (error) {
          console.log('ERROR 1: ', error, this.uploadUri);
          reject(error);
        } else {
          console.log('Batch file sent to AWS. ', new Date().toLocaleTimeString('en-US', {
            hour12: false
          }));
          console.log(response.statusCode, response.statusMessage);
          resolve(response);
        }
      });
    });
  }

  validateConfig() {
    if (!this.config) {
      PushApiHelper.throwError('Missing config (.pushapi-config.json)', 2);
    }
    if (!this.config.platform) {
      this.config.platform = 'push.cloud.coveo.com';
    }

    if (!this.config.apiKey || this.config.apiKey === 'xx--your-api-key--abc') {
      PushApiHelper.throwError('Missing apiKey in .pushapi-config.json', 3);
    }
    if (!this.config.org || this.config.org === 'your-org-id') {
      PushApiHelper.throwError('Missing org in .pushapi-config.json', 4);
    }
    if (!this.config.source || this.config.source === 'your-source-id') {
      PushApiHelper.throwError('Missing source in .pushapi-config.json', 5);
    }
  }
}

module.exports = PushApiHelper;