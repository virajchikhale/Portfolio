FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY ratelimit.conf /etc/nginx/conf.d/00-ratelimit.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY fonts /usr/share/nginx/html/fonts
COPY index.html lite.html recruiter.html script.js ai.js flow.js activity.js style.css config.js /usr/share/nginx/html/
EXPOSE 8080
