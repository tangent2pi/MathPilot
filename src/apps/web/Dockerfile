FROM nginx:1.27-alpine
COPY src/apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY src/apps/web/public /usr/share/nginx/html
EXPOSE 80
