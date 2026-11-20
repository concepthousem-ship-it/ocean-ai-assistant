FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY ocean_core ./ocean_core

# Run as a normal user, not root
RUN useradd --create-home ocean
USER ocean

# Railway sets PORT. Default to 8000 when running elsewhere.
CMD ["sh", "-c", "uvicorn ocean_core.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
