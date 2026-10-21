// Production installs omit devDependencies; hooks are only needed in a checkout.
if (process.env.NODE_ENV !== 'production' && process.env.HUSKY !== '0') {
  import('husky')
    .then(({ default: install }) => console.log(install()))
    .catch((error) => {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    });
}
