# Serve the fully client-side task app from a tiny nginx container.
FROM nginx:1.27-alpine

# Configurable bind address / port (overridable at `docker run` time).
ENV BIND_IP=0.0.0.0 \
    PORT=8234

# Static app assets.
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/  /usr/share/nginx/html/js/

# nginx renders templates in /etc/nginx/templates/*.template through envsubst
# at startup, writing the result to /etc/nginx/conf.d/ (overriding the default
# server block that would otherwise listen on :80).
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template

# Documentation only; the real port is whatever $PORT resolves to at runtime.
EXPOSE 8234

# nginx:alpine already sets a suitable CMD (nginx -g 'daemon off;') and an
# entrypoint that runs the envsubst step before launching.
